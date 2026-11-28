# TASK P2-11 — Mandatory failure-scenario suite (gate for live sales) + small follow-ups

## OBJECTIVE
Prove, in one CI-enforced suite, the **8 mandatory failure scenarios** from `docs/MASTER_ROADMAP.md`. Each test must end with a **reconciliation run (P2-10) reporting `ok`**, so the reconciler is the oracle that the system is consistent after each failure.

This task also adds the two missing capabilities those scenarios need: an operator "supplier rejects" action, and test-only crash injection.

## BACKGROUND
Read:
- `docs/MASTER_ROADMAP.md` ("Mandatory failure scenarios before live sales");
- P2-04 booking, P2-05 checkout + Mock PSP + reconciliation job, P2-07 cancel/refunds, P2-08 notifications;
- P2-10 `ops` reconciliation (`runReconciliationChecks`, statuses), outbox `no_consumer`;
- P1-07 idempotency, P1-08 inbox/outbox.

## SCOPE
### A. Missing capability: supplier/operator rejects a confirmed booking (scenario 4)
- `POST /admin/bookings/:reference/reject`. Roles admin/operator, `@Idempotent()`, `reason` required, and audited via `ADMIN_AUDIT_PORT` (fail-closed).
- It does `confirmed → cancelled` (actor `admin:<id>`), releases seats and creates a **100% refund** (new reason `supplier_rejected`; extend the refunds CHECK by forward migration). Ledger as for departure cancel: Dr `prepayments` P / Cr `refunds_payable` P.
- Outbox `booking.cancelled` → the customer email (P2-08) states the supplier rejection and the full refund (vi/en).
- The admin booking detail (P2-10 web) gets a **Reject booking** button with an in-page confirm and reason.

### B. Test-only crash injection
- A `FaultInjector` provider, active **only** when `APP_ENV=test` **and** `FAULT_INJECTION=1`. Otherwise it is a no-op, and the module refuses to load with `APP_ENV=production` (tested).
- Named fault points throw `SimulatedCrash` at exactly these places:
  - `checkout.after_tx1` (attempt inserted, provider not yet called);
  - `checkout.after_provider_before_tx2` (provider checkout created, `provider_ref` not stored);
  - `webhook.after_inbox_insert_before_handler`;
  - `confirm.after_booking_update_before_ledger` (inside the transaction, so it must roll back fully);
  - `refund.after_processing_before_provider`.
- Recovery must come from **existing** mechanisms only: idempotent retries, the payment reconciliation job, inbox re-processing, and the refund executor retry. If a scenario reveals a gap, fix it minimally and list it in the report.

### C. The suite `apps/api/test/failure-scenarios/*.spec.ts`
- Exactly 8 test files named `fs-01-…` to `fs-08-…`, black-box through HTTP and the Mock PSP endpoints. DB reads are for assertions only.
- **Every test ends with a reconciliation run that reports `ok`** (0 errors, 0 warnings), plus the scenario-specific assertions below.

| # | Scenario | Must prove |
|---|---|---|
| 1 | 50 concurrent requests for the last seat | exactly 1 hold → paid → confirmed; 49 `sold_out`; `allocated` = capacity |
| 2 | Double pay click | 2 concurrent checkout calls with the same key → 1 attempt. Different keys → at most 1 `succeeded`; any second success → `refund_required` → refunded. Customer charged net once (ledger) |
| 3 | Duplicate / early webhook | the callback is delivered 5× concurrently **and** one copy arrives *before* `provider_ref` is stored (use fault `checkout.after_provider_before_tx2` + retry). Final state: 1 confirmation, 1 ledger posting |
| 4 | Paid but supplier rejects | confirmed → `reject` → refund 100% succeeds; seats released; customer email sent; ledger prepayments 0 |
| 5 | Crash mid-saga | for **each** fault point in B: crash, then recovery via retry or jobs, then a consistent final state (confirmed + paid, or expired + refunded). No lost money, no orphan seats |
| 6 | Hold expires as payment arrives | the race repeated 20× → each run is either confirmed + seats held, or expired + `refund_required` → refunded |
| 7 | Price change before pay | quote → new price list → hold with the old hash → `price_changed`; accept the new price → paid at the new total |
| 8 | Cancel during confirm | the customer cancel (`payment_pending`) and the success callback race 20×. Never `cancelled` while charged without a refund, never `confirmed` with released seats |

- **CI:** the suite runs on every PR as a separate named step (`Failure scenarios`) inside the `verify` job. Each file uses its own isolated DB (H-1 helper) and the total wall time stays under 6 min in CI. Report the timing.

### D. Small follow-ups (from earlier reviews)
- **Cursor validation:** `decodeBookingCursor` validates `createdAt` (ISO-8601 with up to 6 fractional digits + `Z`). A malformed cursor → 400 `booking.invalid_query`, not 500. Test it.
- **Test helper location:** move the test DB helper to a `@internationalota/db/testing` subpath export (`package.json` `exports`); the runtime entry no longer exports it. Update imports.

## OUT OF SCOPE
Real PSP, load testing beyond scenario 1, chaos at the infrastructure level (DB failover, network partitions), new UI except the Reject button.

## ACCEPTANCE CRITERIA
1. All 8 `fs-*` tests pass in CI as a named step; each ends with reconciliation `ok`.
2. Fault injection is impossible outside `APP_ENV=test` + flag (tests for production refusal and no-op when the flag is off).
3. Scenario 5 covers all 5 fault points (a table in the report: fault point → recovery mechanism → final state).
4. **Mutation evidence:** each of these makes at least one `fs-*` test fail:
   - (a) remove the inbox dedup;
   - (b) remove the version predicate in the booking transition helper;
   - (c) skip `refund_required` on a late success;
   - (d) release seats outside the cancel transaction;
   - (e) disable the payment reconciliation job;
   - (f) skip the `price_changed` hash check.
5. Reject endpoint: auth 401/403, audit row, idempotent replay, 409 for non-confirmed bookings.
6. D items have tests. The fresh clone and CI are green. `lint:boundaries` is green.
7. Staging: the reject flow runs once end-to-end via the tunnel (reference, refund status, Mailpit email screenshot).

## DELIVERABLES
Branch `task/P2-11-failure-suite`, PR `[P2-11] Failure-scenario suite + supplier reject`, report `reports/TASK-P2-11-report.md` with the scenario table (scenario → test → evidence), the fault-point table, the mutation table, CI timing, the staging evidence and `git ls-remote` proof.
