# TASK H-1 Report — Hygiene: Flaky Teardown (F1), Booking INSERT Guard (N3), Staging Test-Data Cleanup (U6), Time Format (U5)

## 1. Summary of Changes

### F1 — Root Fix for `57P01` Flaky Test Database Teardown

- **Root Cause:** Temporary test DB teardowns executed `pg_terminate_backend(...)` / `DROP DATABASE` while secondary `pg.Pool` instances (such as NestJS `DatabaseModule`'s internal pool or per-test `createDbClient(...)` pools) still held idle backend connections without registered `57P01` teardown guards, or before fire-and-forget `pool.end()` calls completed (e.g., `db.spec.ts` previously used `void client.pool.end()`).
- **Fix:**
  - Added `registerPoolCreatedHook` in [client.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/client.ts) so any pool instantiated via `createDbClient` for a temporary test database is tracked automatically.
  - Created shared lifecycle helper `createIsolatedTestDatabase` + `attachTestPoolErrorGuard` in [test-database.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/test-database.ts), used by both [packages/db/test/test-db.ts](file:///home/iteso/projects/InternationalOTA/packages/db/test/test-db.ts) and [apps/api/test/test-db.ts](file:///home/iteso/projects/InternationalOTA/apps/api/test/test-db.ts):
    1. Automatically tracks every pool targeting `dbName` plus explicit `registerPool` / `registerClient` / `registerApp`.
    2. Ordered teardown: marks `tearingDown = true`, unregisters creation hook, awaits `app.close()`, awaits `client.end()`, awaits `pool.end()` safely for all tracked pools, then executes `pg_terminate_backend` and `DROP DATABASE IF EXISTS ... WITH (FORCE)`.
    3. Attaches a guarded pool `'error'` listener that suppresses **only** SQLSTATE `57P01` strictly while `tearingDown === true`, rethrowing any other error or pre-teardown error loudly.
  - Guarded double-close in [database.module.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/database/database.module.ts) and awaited `client.pool.end()` + added explicit `F1` regression test in [db.spec.ts](file:///home/iteso/projects/InternationalOTA/packages/db/test/db.spec.ts).

### N3 — `BEFORE INSERT` Guard on `booking.bookings`

- Added forward-only migration [0018_booking_insert_guard.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0018_booking_insert_guard.sql) defining `"booking"."trg_fn_bookings_insert_guard"()` and trigger `"trg_bookings_insert_guard" BEFORE INSERT ON "booking"."bookings"`.
- Enforces at database level:
  - `NEW.status = 'held'` and `NEW.version = 1`;
  - `NEW.payment_ref IS NULL`, `NEW.confirmed_at IS NULL`, `NEW.expired_at IS NULL`, `NEW.cancelled_at IS NULL`;
  - `NEW.hold_expires_at > now()`.
- Added raw SQL integration test `N3` in [booking.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/booking/booking.spec.ts) verifying invalid direct `INSERT`s (`status = 'confirmed'`, `version = 2`, non-null `payment_ref`, past `hold_expires_at`) fail while `bookingService.createHold(...)` succeeds.

### U6 — Staging Test-Data Cleanup & Isolation

- Added [staging-cleanup-test-data.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/scripts/staging-cleanup-test-data.ts) exposed via `pnpm staging:cleanup-test-data` in [package.json](file:///home/iteso/projects/InternationalOTA/package.json) and [apps/api/package.json](file:///home/iteso/projects/InternationalOTA/apps/api/package.json).
- Refuses `APP_ENV=production` or any non-`staging` environment (`APP_ENV=staging` only); archives non-demo test products without deleting any booking, inventory, payment, or ledger records, and suspends synthetic non-demo suppliers owning no remaining active products.
- Added integration test `U6` in [demo-loader.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/scripts/demo-loader.spec.ts). (Note: the leftover `pq-p208-vi-a77bf7f6` and `staging-tour-vi-ccc4762c` products on staging originated from manual P2-07/P2-08 staging verification calls; `scripts/e2e-demo2.mjs` does not create catalog products.)

### U5 — Booking & Email Time Display (`HH:mm`, No Seconds)

- Removed default `second: '2-digit'` from `formatInstant` in [format-date.ts](file:///home/iteso/projects/InternationalOTA/packages/i18n/src/format-date.ts) so all shared booking page (`BookingDetailClient.tsx`) and transactional email (`EmailTemplateRenderer`) timestamps format consistently as `HH:mm` without seconds across both `vi` and `en`.
- Added unit/inline-snapshot checks in [i18n.spec.ts](file:///home/iteso/projects/InternationalOTA/packages/i18n/test/i18n.spec.ts) (`"Nov 28, 2026, 08:00"`, `"08:00 28 thg 11, 2026"`), [booking-web.spec.tsx](file:///home/iteso/projects/InternationalOTA/apps/web/src/app/booking-web.spec.tsx), and [notifications.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications.spec.ts).

---

## 2. F1 Proof — 10 Consecutive Full `pnpm test` Runs (Zero Failures)

```text
=== RUN 1/10 (2026-11-27T16:14:08Z) ===
RUN 1/10: PASS (exit 0)
packages/db test:  Test Files  2 passed (2) | Tests  23 passed (23)
apps/web test:  Test Files  3 passed (3) | Tests  17 passed (17)
apps/api test:  Test Files  18 passed (18) | Tests  141 passed (141)
tools test:  Test Files  1 passed (1) | Tests  16 passed (16)
=== RUN 2/10 (2026-11-27T16:15:35Z) ===
RUN 2/10: PASS (exit 0)
=== RUN 3/10 (2026-11-27T16:16:56Z) ===
RUN 3/10: PASS (exit 0)
=== RUN 4/10 (2026-11-27T16:18:07Z) ===
RUN 4/10: PASS (exit 0)
=== RUN 5/10 (2026-11-27T16:19:21Z) ===
RUN 5/10: PASS (exit 0)
=== RUN 6/10 (2026-11-27T16:20:35Z) ===
RUN 6/10: PASS (exit 0)
=== RUN 7/10 (2026-11-27T16:21:58Z) ===
RUN 7/10: PASS (exit 0)
=== RUN 8/10 (2026-11-27T16:23:15Z) ===
RUN 8/10: PASS (exit 0)
=== RUN 9/10 (2026-11-27T16:24:32Z) ===
RUN 9/10: PASS (exit 0)
=== RUN 10/10 (2026-11-27T16:25:47Z) ===
RUN 10/10: PASS (exit 0)
ALL 10/10 RUNS PASSED!
```

---

## 3. N3 Mutation Proof

Temporarily appended `DROP TRIGGER IF EXISTS "trg_bookings_insert_guard" ON "booking"."bookings";` to `0018_booking_insert_guard.sql` and executed the targeted N3 test:

- **Command:** `pnpm --filter @internationalota/api exec vitest run src/modules/booking/booking.spec.ts -t "N3:"`
- **Observed Result (`exit 1`):**
  ```text
  × N3: BEFORE INSERT trigger on booking.bookings rejects pre-confirmed/invalid inserts and allows valid holds
  AssertionError: promise resolved "Result{ command: 'INSERT', …(9) }" instead of rejecting
  ```
- Reverted `0018_booking_insert_guard.sql` immediately; N3 passes cleanly afterwards (`booking.spec.ts` 9/9 across all 10 full runs).

---

## 4. U6 & U5 Live Staging Verification

Staging tunnel (`./scripts/staging-up.sh --with-load`): `https://motion-guards-letting-wings.trycloudflare.com`

### `staging:cleanup-test-data` & `/vi` Product Count Verification

```json
{
  "appEnv": "staging",
  "archivedProductsCount": 2,
  "archivedProductSlugs": [
    "pq-p208-vi-a77bf7f6",
    "staging-tour-vi-ccc4762c"
  ],
  "suspendedSuppliersCount": 2,
  "remainingPublicProductsCount": 8
}
```

- `/api/catalog/products?locale=vi&limit=20` after cleanup: **`PUBLIC_VI_COUNT=8`**
- Re-ran [scripts/e2e-demo2.mjs](file:///home/iteso/projects/InternationalOTA/scripts/e2e-demo2.mjs) on staging (`exit 0`, booking `PQ-T0G44ZYG`):
  ```text
  [e2e-demo2] Target BASE_URL=https://motion-guards-letting-wings.trycloudflare.com
  [e2e-demo2] Target MAILPIT_URL=https://motion-guards-letting-wings.trycloudflare.com/mailpit
  [e2e-demo2] Email verified for e2e-demo2-1795796019760-db037a@example.com
  [e2e-demo2] Signed in cleanly (verified session)
  [e2e-demo2] Quoted tour=lop-hoc-nau-mon-phu-quoc dep=2026-11-30 total=750.000 ₫
  [e2e-demo2] Hold created: ref=PQ-T0G44ZYG status=held
  [e2e-demo2] Submitted Mock PSP Pay successfully
  [e2e-demo2] Server confirmed booking ref=PQ-T0G44ZYG
  [e2e-demo2] Mailpit verified 2 booking emails (held + confirmed)
  [e2e-demo2] Cancellation preview: 100% (750000 VND)
  [e2e-demo2] Refund succeeded: amount=750000 status=succeeded
  [e2e-demo2] PASS — all steps verified for PQ-T0G44ZYG
  ```
- `/api/catalog/products?locale=vi&limit=20` after E2E re-run: **`PUBLIC_VI_COUNT_AFTER_E2E=8`**

### U5 Live Staging Mailpit Email (`HH:mm`, no seconds)

Inspected confirmed notification message `QedzfDb4M8d4uAeog8xqdW` from staging Mailpit:
```text
Giờ khởi hành: 09:00 30 thg 11, 2026 (Asia/Ho_Chi_Minh)
```

---

## 5. CI & Fresh-Clone Verification

- Zero new dependencies (`pnpm-lock.yaml` untouched).
- `pnpm format:check`, `pnpm lint`, `pnpm lint:boundaries`, `pnpm typecheck`, `pnpm build`, `pnpm db:generate`, `pnpm licenses:check`, `pnpm audit --prod --audit-level high`: all passed (`exit 0`).
- Verified fresh clone from `origin/task/H-1-hygiene` (`pnpm install --frozen-lockfile`, `format:check`, `lint`, `lint:boundaries`, `typecheck`, `build`).
