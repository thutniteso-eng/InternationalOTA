# TASK P2-10 — Daily reconciliation + minimal admin console

## OBJECTIVE
Operations can **trust and act on** the system every day:
- an automated daily reconciliation proves that inventory, bookings, payments, refunds and the ledger agree, and flags stuck states;
- a minimal, role-protected admin web lets staff see bookings, act on the few operational actions that already exist (refund retry, departure close/reopen/cancel), and read reconciliation results.

Every admin action is audited.

## BACKGROUND
Read:
- `docs/SOLUTION_ARCHITECTURE.md` (module boundaries + cross-module port pattern);
- P1-09 ledger (accounts by code, balances);
- P2-02 `inventory.verify_allocated()`;
- P2-04 booking + `booking_events`;
- P2-05 `payment_attempts` + `mock_psp_transactions`;
- P2-07 refunds + `POST /admin/refunds/:id/retry` + `POST /admin/departures/:id/cancel`;
- P2-08 `email_messages`;
- P1-08 outbox;
- P2-09 web patterns (auth, i18n, no new deps, no alert/confirm).

## SCOPE
### A. Reconciliation (new module `ops`)
- **Each owning module exposes a read-only check** in its public API, `runReconciliationChecks(asOf) → Finding[]`, so `ops` never reads other schemas directly (`lint:boundaries` must stay green).
- **Finding** = `{ code, severity: 'error'|'warning', entityType, entityId, details }`. Details never contain PII.
- **Checks:**
  1. **Inventory:** `verify_allocated()` is empty, and for every departure `allocated` = the sum of `seats` of bookings in `held` / `payment_pending` / `confirmed` (booking exposes per-departure seat sums; inventory compares).
  2. **Booking ↔ payments:**
     - every `confirmed` booking has exactly one `succeeded` attempt, with `amount` = total, the same currency, and `payment_ref` = `provider_ref`;
     - every `succeeded` attempt belongs to a confirmed (or later cancelled) booking;
     - every `refund_required` attempt has a refund.
  3. **Payments ↔ provider (Mock settlement):** every `mock_psp_transactions` success has a matching attempt in a terminal success state with the same amount, and vice versa. This is the stand-in for future PSP settlement files.
  4. **Ledger identities per currency**, as of `asOf`:
     - `psp_clearing` = Σ succeeded attempts − Σ succeeded refunds;
     - `customer_prepayments` = Σ totals of currently confirmed bookings;
     - `refunds_payable` = Σ open refund amounts (requested / processing / failed / manual_review) + Σ `refund_required` attempts not yet refunded;
     - all journal entries balance.
  5. **Stuck states (warnings):**
     - attempts `initiated` for more than 60 min;
     - refunds in `manual_review`;
     - holds past `hold_expires_at` + 5 min still `held` / `payment_pending`;
     - outbox events dead-lettered or with more than 5 retries;
     - emails `dead`.
- **Tables** `ops.reconciliation_runs` (`id`, `started_at`, `finished_at`, `as_of`, `status` `running|ok|warnings|errors|failed`, `counts jsonb`, `triggered_by`) and `ops.reconciliation_findings` (`run_id`, code, severity, entity, details). Both are insert-only, except the run's own status/finish update, which is guarded.
- **Scheduling:**
  - pg-boss cron at **02:00 Asia/Ho_Chi_Minh** daily, with a single-flight advisory lock so two workers never run concurrently;
  - `POST /admin/reconciliation/runs` (run now, `@Idempotent()`);
  - a run with errors emits the outbox event `ops.reconciliation_errors` and logs at error level.
- Checks are **read-only**: they never fix data.

### B. Admin audit
- `ops.admin_audit` (insert-only: `actor_user_id`, `action`, `target_type`, `target_id`, `reason`, `request_id`, `at`).
- Written in the same transaction as the action for:
  - refund retry;
  - departure close/reopen/cancel;
  - reconciliation run-now;
  - admin role grant (C).

### C. Admin access
- `pnpm admin:grant <email> [--role admin|operator]`, allowed for `APP_ENV` local/staging only; refuses production with instructions (a production grant is a documented SQL runbook, not a script). Writes an audit row.
- All admin routes require role admin/operator. Customers → 403, anonymous → 401 (API) or a redirect to sign-in (web).

### D. Admin web `/{locale}/admin/*` (apps/web, no new deps, vi/en)
1. **Dashboard:** today's and the last 7 days' bookings by status, plus confirmed revenue per currency (formatted via P1-11); the latest reconciliation run status with error/warning counts and a link.
2. **Bookings:**
   - **List:** filters for status, date range, reference and product; cursor pagination.
   - **Detail:** contact data (admin only); status history from `booking_events`; payment attempts; refunds; email messages (template, status; no addresses).
   - Requires a new read-only admin API `GET /admin/bookings/:reference`.
3. **Refunds:** a list filtered to `manual_review`/`failed`, with a **Retry** button (an in-page confirm, reason required), which calls the existing endpoint.
4. **Departures:** per product and date range, with close/reopen and **Cancel departure** (an in-page confirm showing the affected bookings count, reason required), which calls the existing endpoints.
5. **Reconciliation:**
   - runs list, plus run detail with findings grouped by code;
   - entity links to booking detail where applicable;
   - a "Run now" button.

Every admin page shows the DEMO banner (non-production). Contact PII is visible only on admin pages and never in lists beyond the name.

## OUT OF SCOPE
Catalog/pricing/inventory editing UI (APIs exist; a later task), user management UI, charts library, exports/CSV, supplier portal, automatic data repair.

## ACCEPTANCE CRITERIA (integration tests, isolated temp DB)
1. **Clean run:** after the full happy, cancel, late-payment and double-payment flows (reuse P2-05/P2-07 helpers), a run reports `ok` with 0 errors and the ledger identities hold.
2. **Each check catches its fault.** Inject each fault via raw SQL (as owner, triggers disabled only inside the test where needed), then expect the specific error code:
   - (a) `allocated` off by 1;
   - (b) a confirmed booking without a succeeded attempt;
   - (c) a mock success without an attempt;
   - (d) a ledger posting removed or added (unbalanced identity);
   - (e) an attempt amount ≠ booking total.

   One test per fault.
3. **Stuck warnings:** an initiated attempt older than 60 min, a refund in `manual_review`, and an overdue hold → warnings, run status `warnings`.
4. **Single-flight:** two concurrent run-now calls (different keys) → 1 run executes and the other returns `already_running` (409).
5. **Read-only proof:** a run makes no writes outside the `ops` tables. Assert row counts and the ledger before and after.
6. **Audit:** every admin action in B creates exactly one audit row in the same transaction. A rollback of the action leaves no audit row.
7. **Access:** customer → 403 on every `/admin` API; anonymous → 401; `admin:grant` refuses production; web admin pages redirect anonymous users to sign-in and show 403 to customers.
8. **Boundaries:** `ops` imports only public module APIs, and `lint:boundaries` is green. Show a deliberate violation failing.
9. **Web tests (Vitest):** dashboard figures formatted vi/en; the cancel-departure confirm requires a reason and shows the affected count; booking detail shows history and refunds; no `alert`/`confirm`.
10. **Mutation evidence** (each kills ≥ 1 test):
    - (a) skip the inventory seat-sum check;
    - (b) compute `customer_prepayments` without excluding cancelled bookings;
    - (c) remove the single-flight lock;
    - (d) write the audit row outside the action transaction.
11. **Staging:** run reconciliation on staging (report status and counts); screenshots at 390px and 1280px of the dashboard, booking detail and a reconciliation run (vi); a fresh clone and CI green.

## DELIVERABLES
Branch `task/P2-10-admin-recon`, PR `[P2-10] Daily reconciliation + minimal admin`, report `reports/TASK-P2-10-report.md` with the check catalogue table, the mutation table, screenshots, staging run output and `git ls-remote` proof.
