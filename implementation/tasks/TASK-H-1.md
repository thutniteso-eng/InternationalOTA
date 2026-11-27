# TASK H-1 — Hygiene: flaky test teardown (F1), booking insert guard (N3), staging test-data leak (U6), time format (U5)

## OBJECTIVE
Make CI deterministic and close small integrity and UX gaps found in the P2-04…P2-09 reviews. No new features.

## SCOPE
### F1 — the 57P01 flake
- **Symptom:** `57P01 terminating connection due to administrator command`. It surfaces as an unhandled error in Vitest when a temporary test DB is dropped `WITH (FORCE)` while a `pg.Pool` still holds idle clients. It has been seen in `idempotency.spec`, `packages/db` tests and others: about 1 in 2–3 full runs.
- **Fix it at the root, in the shared test-DB helper(s)** (find every `DROP DATABASE` in test helpers):
  1. Every pool or client created for a temp DB is registered with the helper.
  2. Teardown awaits app close (Nest `app.close()`, pg-boss `stop({ graceful: true })`), then `pool.end()` for every registered pool, then `DROP DATABASE … WITH (FORCE)` from the admin connection.
  3. Each pool gets an `error` listener that swallows **only** `57P01` during teardown (a flag set by the helper); anything else is rethrown or logged.
- **Proof:** run the full `pnpm test` **10 times** in a row with 0 failures and attach the loop output. CI stays green.

### N3 — booking INSERT guard
- **Migration:** a `BEFORE INSERT` trigger on `booking.bookings` enforces:
  - `status = 'held'`, `version = 1`;
  - `payment_ref`, `confirmed_at`, `expired_at` and `cancelled_at` IS NULL;
  - `hold_expires_at > now()`.
- **Test:** raw SQL inserting a `confirmed` booking fails, and the normal path still works.
- **Mutation:** drop the trigger → the test fails.

### U6 — staging catalog polluted by test products
- Integration tests use isolated temp DBs and must never touch staging.
- Find what created products like "South Phu Quoc 4-Island Boat Tour (a77bf7f6)" on staging (likely the P2-08/P2-09 E2E or seeding scripts). Make those scripts use a dedicated **hidden** supplier `E2E Test Supplier (Demo)` with status `suspended` after the run, or archive the products they create, so the public list shows only the 8 demo tours.
- Provide a one-off script `pnpm staging:cleanup-test-data` (APP_ENV=staging only; refuses production) that archives non-demo products created by test scripts. Archive only — never delete bookings or ledger rows.
- Run it on staging and show the public list count = 8.

### U5 — time display
Booking and email times show `HH:mm` (no seconds) in both locales. Use the shared formatter in `packages/i18n` and test it.

## OUT OF SCOPE
Anything else. No dependency changes.

## ACCEPTANCE CRITERIA
1. 10 consecutive full `pnpm test` runs pass (output attached). The fresh clone and CI are green.
2. The N3 raw-SQL test passes, and the mutation is shown killed.
3. Staging `/vi` lists exactly the 8 demo tours after cleanup. The E2E script, re-run once, leaves the count at 8.
4. U5: there is a snapshot/unit test for the vi/en time format, and the booking page and email show `08:00`.

## DELIVERABLES
Branch `task/H-1-hygiene`, PR `[H-1] Hygiene: test teardown, insert guard, staging test data, time format`, report `reports/TASK-H-1-report.md`, and `git ls-remote` proof.
