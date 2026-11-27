# TASK P2-07 — Cancellation after confirmation & refund execution (Mock), with ledger

## OBJECTIVE
Money that must go back to a customer is **always** tracked to completion. That covers four cases:
- the customer cancels a confirmed booking (refund per the booking's own policy snapshot);
- the operator cancels a departure (e.g. weather → 100% refund);
- a late payment (P2-05 `refund_required`);
- a double payment.

Refunds execute through the `PaymentProvider` port (Mock now). Every step is posted to the ledger, and the ledger stays balanced.

## BACKGROUND
Read:
- P2-03 `computeRefund` (`RoundingMode.DOWN`) and the `rules` stored in `quote_snapshot`;
- P2-04 booking trigger (transitions and immutable columns, migration 0014) and the history actor convention;
- P2-05 `payment_attempts`, the `payment.refund_required` outbox event, the ledger accounts `asset:psp_clearing:<prov>:<CUR>`, `liability:customer_prepayments:<CUR>`, `liability:refunds_payable:<CUR>`, and `LedgerService.ensureAccount`;
- P1-08 inbox/outbox; D-020; **D-004 is still open** (merchant model). Therefore the retained cancellation amount goes to a **neutral liability** account, not revenue.

## SCOPE
### A. Booking state
- **Migration:** extend the transition trigger with `confirmed → cancelled` (sets `cancelled_at`). Everything else is unchanged.
- **Actors:** `customer:<id>` (customer cancel), `admin:<id>` (departure cancel), `system:…` (automated).

### B. Refunds (module `payments`, new table)
- **`payments.refunds`:**
  - `id` (v7), `booking_id`, `payment_attempt_id`, `amount_minor CHECK (> 0)`, `currency`;
  - `reason` CHECK IN (`customer_cancellation`, `departure_cancelled`, `late_payment`, `double_payment`);
  - `status` CHECK IN (`requested`, `processing`, `succeeded`, `failed`, `manual_review`), DB-guarded transitions + version (same pattern);
  - `provider_refund_ref` (`UNIQUE (provider, provider_refund_ref)`), `attempts int`, `last_error`, timestamps.
- **Over-refund guard (DB):** the sum of non-failed refund amounts per `payment_attempt_id` must never exceed the attempt amount. Enforce it with a trigger that locks the attempt row, and test it with raw SQL.
- **Port additions:**
  - `PaymentProvider.refund({ providerRef, refundId, amountMinor, currency }) → { providerRefundRef }`, idempotent by `refundId`;
  - refund callbacks `refund.succeeded` / `refund.failed` are signed and deduplicated exactly like payment callbacks.
  - Mock: the hosted dev panel or a config knob selects auto-succeed (default), auto-fail, or delay. Its state lives in the mock table.
- **Executor:**
  - a pg-boss job picks `requested` refunds (`SKIP LOCKED`), marks them `processing`, then calls the provider outside the DB transaction;
  - on provider error it backs off, up to 3 tries, then → `manual_review` (error log + outbox `refund.manual_review`);
  - a callback finalises `succeeded` / `failed`; `failed` re-enters the retry policy.
  - Admin endpoint `POST /admin/refunds/:id/retry` (`manual_review` → `requested`), `@Idempotent()`, roles admin/operator.

### C. Flows (each in one DB transaction unless stated)
1. **Customer cancels a confirmed booking** — `POST /bookings/:reference/cancel`. This extends the P2-04 endpoint; `held`/`payment_pending` behaviour is unchanged.
   - The refund amount R = `computeRefund(snapshot rules, startsAt, now() [DB], paid)`, and K = paid − R.
   - Lock the booking, transition `confirmed → cancelled`, release the seats (inventory API) and create a refund (`customer_cancellation`) only if R > 0.
   - **Ledger:** Dr `customer_prepayments` P; Cr `refunds_payable` R; Cr `liability:cancellation_retained:<CUR>` K. Omit zero lines.
   - The response shows `refundAmountMinor`, `refundPercent`, `ruleApplied`, and the refund status.
   - Cancelling after the departure start → 409 `too_late_to_cancel`. No-show handling is out of scope.
2. **Operator cancels a departure** — `POST /admin/departures/:id/cancel` (admin/operator, `@Idempotent()`, `reason` required):
   - sets the departure `cancelled` via the inventory API;
   - enqueues one job per confirmed booking. Each job: `confirmed → cancelled` (actor `admin:<id>`), release, refund **100%** (`departure_cancelled`), ledger Dr prepayments P / Cr refunds_payable P;
   - `held` / `payment_pending` bookings on that departure are cancelled without a refund;
   - a summary endpoint shows counts.
3. **Late or double payment:** a consumer of the `payment.refund_required` outbox event creates a refund for the full attempt amount (`late_payment` / `double_payment`). The ledger already holds Cr `refunds_payable` from P2-05, so no new posting is made at creation.
4. **Refund succeeded:** Dr `refunds_payable` R; Cr `psp_clearing` R.
5. **Booking detail** (owner) adds `refund: { amountMinor, status }` when one exists.

## OUT OF SCOPE
Real PSP refunds, partial manual refunds by admin, no-show rules, supplier payables/commission (D-004), customer emails (P2-08), UI (P2-09).

## ACCEPTANCE CRITERIA (integration tests, isolated temp DB, Mock provider)
1. **Refund table** (policy 48h → 100%, 24h → 50%, 0h → 0%; paid 1,000,001 VND), cancelling at:
   - 72h before → R = 1,000,001, K = 0;
   - 30h before → R = 500,000, K = 500,001;
   - 2h before → R = 0: no refund row, ledger Dr prepayments / Cr retained;
   - after the start → 409.
2. **End-to-end:** pay (P2-05), then cancel at 72h, then the executor runs, then the mock callback arrives. Result: refund `succeeded`; booking `cancelled`; seats released; `verify_allocated()` empty; balances `customer_prepayments` = 0, `refunds_payable` = 0, `psp_clearing` = 0. History shows `confirmed → cancelled`.
3. **Concurrency:**
   - two concurrent cancels of the same confirmed booking → one transition, one refund, one ledger entry;
   - customer cancel vs departure cancel racing on the same booking (20 runs) → exactly one cancellation and one refund. The reason is whichever won.
4. **Over-refund guard:** raw SQL inserting a second refund that exceeds the attempt amount fails. The concurrent executor plus admin retry never produce two `succeeded` refunds for one refund row.
5. **Failure path:** the mock refund fails 3× → `manual_review` with an outbox event; admin retry → succeeds, and the ledger is correct. Duplicate refund callbacks → a single posting.
6. **Departure cancel:** 5 confirmed, 2 held and 1 payment_pending bookings → 5 refunds at 100%, 3 cancelled without refund, departure `cancelled`, all seats released. Re-calling the endpoint with the same key → the same result and no duplicates.
7. **Late and double payment** (from P2-05 paths) → a refund is created automatically and succeeds, and `refunds_payable` returns to 0.
8. **Ledger:** a final assertion that every account in the suite has its expected balance and all entries balance.
9. **Authorization:** another customer → 404; customer on admin endpoints → 403; anonymous → 401.
10. **Mutation evidence** (each kills ≥ 1 test):
    - (a) rounding `DOWN` → `HALF_UP` in the cancel path;
    - (b) drop the over-refund trigger;
    - (c) release seats outside the cancel transaction;
    - (d) post the refund-success ledger entry twice (no dedup);
    - (e) use the app clock for `cancelledAt`/refund timing.
    Also a `lint:boundaries` violation demo, fresh clone + CI green, and staging pay → cancel → refund succeeded via the tunnel, with ledger balances in the report.

## DELIVERABLES
Branch `task/P2-07-cancel-refund`, PR `[P2-07] Cancellation & refunds`, report `reports/TASK-P2-07-report.md` with a Mermaid diagram (refund lifecycle + ledger postings), verbatim test output, the mutation table and `git ls-remote` proof.
