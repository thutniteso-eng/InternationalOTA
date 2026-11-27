# TASK P2-04 Report — Booking Aggregate, State Machine & Expiring Holds

Branch: `task/P2-04-booking-holds`  
Staging Tunnel URL: `https://greatest-charts-valuation-massive.trycloudflare.com` (`/api/health/ready -> 200 OK`)

## 1. Summary of Changes

### A. Schema & DB Triggers ([booking.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/schema/booking.ts), [0013_lonely_the_anarchist.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0013_lonely_the_anarchist.sql), [roles.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/roles.ts))
- **`booking.bookings`**:
  - `id` (UUIDv7), unique human `reference` (`PQ-` + 8 Crockford base32 characters, collision-retried via `SAVEPOINT`), `customer_user_id`, `product_id`, `departure_id`, `status` (`held | payment_pending | confirmed | expired | cancelled`), `pax` jsonb, `seats > 0`, `currency`, `total_amount_minor >= 0`, `quote_snapshot`, `snapshot_hash`, contact fields, `allocation_ref = booking.id` (unique per hold attempt — satisfies P2-02 L3), `hold_expires_at`, `payment_ref`, `version` (default 1), and timestamps.
  - Consistency `CHECK`s: `confirmed => payment_ref IS NOT NULL AND confirmed_at IS NOT NULL`, `expired => expired_at IS NOT NULL`, `cancelled => cancelled_at IS NOT NULL`.
  - Indexes: partial `(status, hold_expires_at) WHERE status IN ('held', 'payment_pending')`, `(customer_user_id, created_at DESC)`, `(departure_id)`.
- **`booking.booking_events`** (insert-only):
  - Triggers `trg_booking_events_immutable` (`BEFORE UPDATE OR DELETE`) and `trg_booking_events_no_truncate` (`BEFORE TRUNCATE`) raise SQLSTATE `23001` (`restrict_violation`).
  - `AFTER INSERT OR UPDATE` trigger `trg_booking_events_audit` writes an audit row automatically on creation and every status change using transaction-local `booking.actor` / `booking.reason` settings (DB clock `now()`).
- **Transition trigger `trg_bookings_transition`** (`BEFORE UPDATE`):
  - Enforces `NEW.version = OLD.version + 1`, blocks modification of immutable core columns, and permits ONLY the legal edges (`held -> payment_pending | expired | cancelled`, `payment_pending -> confirmed | expired | cancelled`), raising SQLSTATE `23514` (`check_violation`) otherwise.
- **`ota_app` runtime grants:** `SELECT, INSERT, UPDATE` on `booking.bookings` (no `DELETE`) and `SELECT, INSERT` on `booking.booking_events`.

### B. Booking Module, Concurrency & Expiry Worker ([booking.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/booking/booking.service.ts), [booking.controller.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/booking/booking.controller.ts), [booking-admin.controller.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/booking/booking-admin.controller.ts))
- **`createHold`** (single `READ COMMITTED` transaction): re-quotes via `PricingService.quote`, rejects stale prices with typed `price_changed` + fresh quote (`409`), enforces ≤ 3 active holds per customer under a customer-scoped advisory lock (`pg_advisory_xact_lock`), inserts `booking` (`held`), calls `InventoryService.allocate(..., tx)` (rolling back via abort sentinel on non-`allocated` outcomes `sold_out | closed | cutoff_passed | not_found`), and enqueues `booking.held` in `OutboxService`. Validates `BOOKING_HOLD_MINUTES` (default `15`, allowed `5..60`) at boot.
- **Single transition gate (`BookingService.transitionBooking`)**: acquires `FOR UPDATE`, checks legal edges and optional `expectedVersion`, executes conditional `UPDATE ... SET version = version + 1 WHERE id = $id AND version = $v` with transaction-local actor/reason.
- **`markPaymentPending`**: reads `IdentityService.isEmailVerified(userId)` (D-018) -> returns `403 email_not_verified` when unverified; preserves `hold_expires_at`. Exposed via temporary endpoint `POST /bookings/:reference/payment-pending` (**internal/temporary until P2-06 payment initiation**).
- **`confirm`** (internal for P2-06) & **`cancelBeforePayment`**: atomic conditional transitions; `confirm` is idempotent on matching `paymentRef` (`conflict` on mismatch, `not_confirmable` on expired/cancelled); `cancelBeforePayment` releases seats once in the same tx (`409 not_cancellable` on `confirmed`/`expired`).
- **`expireDue`** + **`JobQueueService` cron (`booking-hold-expiry`, `* * * * *`)**: claims due holds per transaction with `FOR UPDATE SKIP LOCKED`, transitions `-> expired`, calls `InventoryService.release(..., tx)`, and enqueues `booking.expired`. Pre-created in `staging-migrate.ts`.
- **PII protection (`logger.ts`)**: added `contact`, `contactname`, `contactemail`, `contactphone`, `email`, `phone` to `SENSITIVE_KEYS` and omitted contact PII from outbox payloads and service logs.

---

## 2. Booking State Machine Diagram

```mermaid
stateDiagram-v2
    [*] --> held : createHold() + allocate(tx) + outbox booking.held
    held --> payment_pending : markPaymentPending() [D-018 emailVerified == true]
    held --> expired : expireDue() [SKIP LOCKED] + release(tx) + booking.expired
    held --> cancelled : cancelBeforePayment() + release(tx) + booking.cancelled
    payment_pending --> confirmed : confirm(paymentRef) [payment_ref IS NOT NULL] + booking.confirmed
    payment_pending --> expired : expireDue() [SKIP LOCKED] + release(tx) + booking.expired
    payment_pending --> cancelled : cancelBeforePayment() + release(tx) + booking.cancelled
    confirmed --> [*]
    expired --> [*]
    cancelled --> [*]
```

*DB Enforcement:* Every transition increments `version = OLD.version + 1`; illegal status changes or stale versions fail `trg_bookings_transition` (`SQLSTATE 23514`), terminal `CHECK` constraints enforce `payment_ref`/`*_at` non-null invariants, and `trg_booking_events_audit` writes every transition into append-only `booking.booking_events`.

---

## 3. Mutation Evidence Table (`(a)`–`(f)`)

Each mutation was applied individually against clean code, executed against `booking.spec.ts` on an isolated temp PostgreSQL DB, verified to fail, and immediately reverted:

| ID | Injected Mutation | Killed Test Case | Verbatim Failure Output |
|---|---|---|---|
| **(a)** | Remove `eq(bookingBookings.version, expectedVersion)` predicate in `transitionBooking` | `AC6: DB transition trigger, optimistic version predicate (Mutation a), booking_events immutability, and ota_app grants` | `AssertionError: expected { ok: true, booking: { …(24) } } to deeply equal { Object (ok, reason) }` |
| **(b)** | Drop `trg_bookings_transition` trigger from `0013_lonely_the_anarchist.sql` | `AC6: DB transition trigger, optimistic version predicate (Mutation a), booking_events immutability, and ota_app grants` | `AssertionError: promise resolved "Result{ command: 'UPDATE', …(9) }" instead of rejecting` |
| **(c)** | Remove `FOR UPDATE SKIP LOCKED` and status re-check in `expireDue` / `transitionBooking` | `AC4: Single expiry + 30 concurrent expiry race + atomic release check` | `Caused by: error: Illegal booking status transition from "expired" to "expired"` |
| **(d)** | Skip `isSameQuote` hash check in `createHold` | `AC3: Stale quote triggers 409 price_changed with fresh quote and writes zero rows/allocations` | `AssertionError: expected 201 to be 409 // Object.is equality` |
| **(e)** | Move `inventoryService.release(...)` outside the `expireDue` transaction | `AC4: Single expiry + 30 concurrent expiry race + atomic release check` | `AssertionError: expected 'expired' to be 'held' // Object.is equality` (`Expected: "held"`, `Received: "expired"`) |
| **(f)** | Remove customer advisory lock (`pg_advisory_xact_lock`) in `createHold` | `AC7 & AC8 & AC9 & AC10 & AC11: ... anti-hoarding ...` | `AssertionError: expected [ …(4) ] to have a length of 3 but got 4` |

---

## 4. Automated Test & Verification Evidence

### `booking.spec.ts` & `observability.spec.ts`
```text
 ✓ src/common/observability/observability.spec.ts (9 tests) 1582ms
 ✓ src/modules/booking/booking.spec.ts (7 tests) 25268ms
     ✓ AC1: Last seat — 50 concurrent customers contend for capacity=1; exactly 1 wins and 49 get 409 sold_out  10408ms
     ✓ AC2: Double submit with same Idempotency-Key + replay yields 1 booking; distinct key creates a 2nd hold  455ms
     ✓ AC3: Stale quote triggers 409 price_changed with fresh quote and writes zero rows/allocations
     ✓ AC4: Single expiry + 30 concurrent expiry race + atomic release check  6467ms
     ✓ AC5: Expiry vs confirm race (20 iterations) — ends in one terminal state, seats released iff expired  4479ms
     ✓ AC6: DB transition trigger, optimistic version predicate (Mutation a), booking_events immutability, and ota_app grants  457ms
     ✓ AC7 & AC8 & AC9 & AC10 & AC11: D-018, auth/ownership 404/401/403, anti-hoarding, cancel, PII redaction, and static write guard  1005ms

 Test Files  2 passed (2)
      Tests  16 passed (16)
```

### `pnpm lint:boundaries` Violation Demo & Clean State
With temporary internal import `import { InventoryService as _InternalInv } from '../inventory/inventory.service.js';` in `apps/api/src/modules/booking/booking.service.ts`:
```text
$ pnpm lint:boundaries

  error no-sibling-module-internal-imports: apps/api/src/modules/booking/booking.service.ts → apps/api/src/modules/inventory/inventory.service.ts

x 1 dependency violations (1 errors, 0 warnings). 134 modules, 554 dependencies cruised.
```
After reverting:
```text
$ pnpm lint:boundaries

✔ no dependency violations found (134 modules, 553 dependencies cruised)
```

### Full Monorepo Checks (`main` -> `task/P2-04-booking-holds`)
- `pnpm format:check`: passed
- `pnpm lint`: passed
- `pnpm lint:boundaries`: passed (`134 modules, 553 dependencies cruised`, 0 violations)
- `pnpm typecheck`: passed
- `pnpm build` & compiled ESM load (`BOOKING_COMPILED_ESM_OK`): passed
- `pnpm db:generate`: `No schema changes, nothing to migrate` (28 tables)
- `pnpm test` (`DATABASE_URL=postgresql://ota_user:ota_password@localhost:55432/ota_dev`):
  - `@internationalota/api`: `15` files / `112` tests passed
  - `@internationalota/web`: `2` files / `8` tests passed
  - `packages/*`: `i18n` `21`, `money` `41`, `time` `22`, `db` `19`, `shared` `2` passed; `tools` `16` passed
- `pnpm licenses:check`: `All 471 package licenses verified successfully`
- `pnpm audit --prod --audit-level high`: exit 0

---

## 5. Staging Deployment, `ota_app` Grants & Expiry Job Proof

- **Live tunnel URL:** `https://greatest-charts-valuation-massive.trycloudflare.com` (`/api/health/ready -> 200 OK`; anonymous `/api/me/bookings` -> `401`; anonymous `/api/admin/bookings` -> `401`)
- **`ota_app` grants in `ota_staging`:**
```text
   table_name   |        privileges        
----------------+--------------------------
 booking_events | INSERT , SELECT
 bookings       | INSERT , SELECT , UPDATE
(2 rows)
```
- **`pgboss` queue & live cron execution logs in staging (`api` container):**
```text
        name         |  policy  |          created_on           
---------------------+----------+-------------------------------
 booking-hold-expiry | standard | 2026-11-27 11:38:13.220799+00
(1 row)

api-1  | {"level":"info","time":"2026-11-27T11:38:24.130Z","service":"api","env":"production","appEnv":"staging","context":"JobQueueService","level":"info","event":"booking_expiry_job_scheduled","queue":"booking-hold-expiry","cron":"* * * * *","msg":"booking_expiry_job_scheduled"}
api-1  | {"level":"info","time":"2026-11-27T11:39:00.110Z","service":"api","env":"production","appEnv":"staging","context":"JobQueueService","level":"info","event":"booking_expiry_job_completed","expiredCount":0,"skippedCount":0,"msg":"booking_expiry_job_completed"}
```

---

## 6. Corrections (R1)

- **Forward-only migration:** `packages/db/migrations/0014_booking_transition_column_locks.sql` (registered in `packages/db/migrations/meta/_journal.json`) replaces `booking.trg_fn_bookings_transition()` without touching `0013`:
  - Locks `pax`, `seats`, `quote_snapshot`, `hold_expires_at`, `contact_name`, `contact_email`, `contact_phone`, `contact_locale`, and `created_at` (in addition to existing core immutable columns) using `IS DISTINCT FROM` (`ERRCODE = 'restrict_violation'`).
  - Enforces that `payment_ref` and `confirmed_at` may only transition from `NULL` to a non-NULL value on `NEW.status = 'confirmed'`, `expired_at` only from `NULL` to non-NULL on `NEW.status = 'expired'`, and `cancelled_at` only from `NULL` to non-NULL on `NEW.status = 'cancelled'`.
- **Raw SQL tests (`apps/api/src/modules/booking/booking.spec.ts`, test `R1`):**
  - Verifies raw `UPDATE booking.bookings SET status = 'payment_pending', version = version + 1, ...` fails for every locked column (`seats`, `pax`, `hold_expires_at`, `quote_snapshot`, `contact_name`, `contact_email`, `contact_phone`, `contact_locale`, `created_at`).
  - Verifies setting `payment_ref`, `confirmed_at`, `expired_at`, or `cancelled_at` on the wrong transition fails, while legal `held -> payment_pending -> confirmed` succeeds.
- **R1 Mutation Proof (remove added immutable column locks from `0014`):**
  - Temporarily stripping `pax`, `seats`, `quote_snapshot`, `hold_expires_at`, `contact_*`, `created_at` from `0014` caused `vitest run src/modules/booking/booking.spec.ts -t "R1"` to **FAIL** (`MUTATION_EXIT=1`) at `src/modules/booking/booking.spec.ts:989` (`AssertionError: promise resolved "Result{ command: 'UPDATE', …(9) }" instead of rejecting`); restored immediately and re-verified green.
- **Post-R1 Full Verification (`ota_dev`):**
  - `pnpm format:check`, `pnpm lint`, `pnpm lint:boundaries` (`134 modules, 553 dependencies cruised`), `pnpm typecheck`, `pnpm build`, `pnpm db:generate` (`No schema changes, nothing to migrate`), `pnpm db:migrate`: all passed.
  - `pnpm test` (`DATABASE_URL=postgresql://ota_user:ota_password@localhost:55432/ota_dev`): `@internationalota/api` `15` files / `113` tests passed (including `booking.spec.ts` `8/8`), `@internationalota/web` `2` files / `8` tests passed, `packages/*` (`shared` `2`, `db` `19`, `money` `41`, `i18n` `21`, `time` `22`), `tools` `16` passed.
  - `pnpm licenses:check` (`471` packages) & `pnpm audit --prod --audit-level high`: exit 0.
