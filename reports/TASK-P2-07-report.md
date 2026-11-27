# TASK P2-07 Report — Cancellation After Confirmation & Refund Execution

## 1. Summary of Changes

Implemented customer cancellation after confirmation, operator departure-wide cancellation, automatic refund creation from `payment.refund_required` outbox events (`late_payment` / `double_payment`), `MockPaymentProvider` refund API & signed refund callbacks, pg-boss refund execution with exponential backoff and `manual_review` escalation, and atomic double-entry ledger postings without adding any Node dependencies.

### Database & Migrations (Forward-Only)

- [payments.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/schema/payments.ts) & [0016_vengeful_arclight.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0016_vengeful_arclight.sql):
  - Added `payments.mock_psp_transactions.refund_mode` (`auto_succeed` | `auto_fail` | `delay`).
  - Created `payments.refunds` (columns: `id`, `booking_id`, `payment_attempt_id`, `provider`, `amount_minor`, `currency`, `reason`, `status`, `provider_refund_ref`, `attempts`, `last_error`, `next_attempt_at`, `version`, `created_at`, `updated_at`, `completed_at`; unique `(provider, provider_refund_ref)`; checks for positive `amount_minor`, `attempts >= 0`, `version > 0`, `completed_at` consistency) and `payments.mock_psp_refunds`.
  - Updated `booking.trg_fn_bookings_transition()` to allow `confirmed -> cancelled` (locking immutable columns and gating `cancelled_at` to `NULL -> non-NULL` on transition to `cancelled`).
  - Added `payments.trg_fn_refunds_transition()` (`version = OLD.version + 1`, immutable core columns, `succeeded` finality, and valid transitions across `requested | processing | failed | manual_review | succeeded`).
  - Added `payments.trg_fn_refunds_over_refund_guard()` (`BEFORE INSERT OR UPDATE` locking the parent `payments.payment_attempts` row `FOR UPDATE`, asserting currency equality and `SUM(non-failed refunds) <= attempt.amount_minor`).
- [roles.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/roles.ts): granted least-privilege `SELECT, INSERT, UPDATE` on `payments.refunds` and `payments.mock_psp_refunds` to `ota_app`.

### Modules & APIs

- **Booking & Inventory (`apps/api/src/modules/booking/`, `apps/api/src/modules/inventory/`):**
  - `InventoryService.getDepartureStartsAtWithDbNow` fetches `starts_at` and DB `now()` in the same query.
  - `BookingService.cancelByReferenceHttp` routes `held`/`payment_pending` cancellations to `cancelBeforePayment` and `confirmed` cancellations to the `CONFIRMED_BOOKING_CANCELLATION_PORT` implemented by `RefundService`.
  - Added `cancelConfirmedWithLock`, `cancelActiveHoldOnDeparture`, `listBookingsForDeparture`, and `bookingTooLateToCancelException` (409) when DB `now() > departure.starts_at`.
  - `GET /bookings/:reference` includes `refund: { amountMinor, status }` via `BOOKING_PAYMENT_SUMMARY_PORT`.
- **Payments & Refunds (`apps/api/src/modules/payments/`, `apps/api/src/modules/messaging/`):**
  - `MockPaymentProvider` & `MockPspController`: added idempotent `refund(...)`, `getRefundStatus(...)`, signed `refund.succeeded` / `refund.failed` callbacks, and dev-panel `refund_auto_succeed` / `refund_auto_fail` / `refund_delay` toggles.
  - `RefundService` & `RefundAdminController`:
    - `POST /bookings/:reference/cancel` (`@Idempotent()`): computes refund using `computeRefund` (`RoundingMode.DOWN`) with `startsAt` and DB clock `cancelledAt`, cancels booking and releases inventory inside `tx`, inserts `payments.refunds` (when `refundAmountMinor > 0n`), posts `booking_cancellation` ledger entry (`Dr liability:customer_prepayments:<CUR>`, `Cr liability:refunds_payable:<CUR>`, `Cr liability:cancellation_retained:<CUR>`), and wakes the `refund-executor` pg-boss worker.
    - `POST /admin/departures/:id/cancel` (`@Idempotent()`, requires `reason`): cancels departure, synchronously cancels active `held`/`payment_pending` bookings, and enqueues `departure-booking-cancel` jobs for all `confirmed` bookings (100% refund with reason `departure_cancelled`).
    - `GET /admin/departures/:id/cancellation-summary`: returns departure status, booking counts by status, and refund counts/totals by status.
    - Consumes `payment.refund_required` outbox events for `late_payment` and `double_payment` attempts (`100%` refund).
    - `processDueRefunds()` claims due refunds with `FOR UPDATE SKIP LOCKED`, marks `processing`, calls provider `refund()`, handles failures with exponential backoff (`1000ms * 2^(attempt-1)`) up to `3` attempts before escalating to `manual_review` + `refund.manual_review` outbox event.
    - `handleRefundWebhook()` settles `refund.succeeded` once inside `InboxService` transaction, posting `refund_settled` (`Dr liability:refunds_payable:<CUR>`, `Cr asset:psp_clearing:<provider>:<CUR>`).
    - `POST /admin/refunds/:id/retry` (`@Idempotent()`) transitions `manual_review` -> `requested` for re-execution.

---

## 2. Refund Lifecycle & Double-Entry Ledger Diagrams

### Refund Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> requested : Cancel / departure_cancelled / late or double_payment (R > 0)
    requested --> processing : Executor claims via FOR UPDATE SKIP LOCKED (attempts + 1)
    processing --> succeeded : Signed webhook refund.succeeded (amount & currency match)
    processing --> failed : Provider error / timeout / refund.failed (attempts < 3, backoff)
    failed --> processing : Executor retries after next_attempt_at
    processing --> manual_review : Failed 3rd attempt (+ outbox refund.manual_review)
    manual_review --> requested : Admin POST /admin/refunds/:id/retry (resets attempts=0)
    succeeded --> [*] : Terminal (trg_refunds_transition blocks updates)
```

### Double-Entry Ledger Flow (`paidMinor = P`, `refundAmountMinor = R`, `retainedMinor = K = P - R`)

```mermaid
flowchart LR
    subgraph Pay["1. Payment Capture (payment_captured)"]
        A1["Dr asset:psp_clearing:mock:VND (+P)"] --> L1["Cr liability:customer_prepayments:VND (+P)"]
    end
    subgraph Cancel["2. Confirmed Cancellation (booking_cancellation)"]
        L2["Dr liability:customer_prepayments:VND (-P)"]
        L2 -->|"R > 0"| L3["Cr liability:refunds_payable:VND (+R)"]
        L2 -->|"K > 0"| L4["Cr liability:cancellation_retained:VND (+K)"]
    end
    subgraph Settle["3. Refund Settlement Webhook (refund_settled)"]
        L5["Dr liability:refunds_payable:VND (-R)"] --> A2["Cr asset:psp_clearing:mock:VND (-R)"]
    end
    Pay --> Cancel --> Settle
```

---

## 3. Mutation Testing Proof (a–e) & Boundary Check Demo

Each mutation was applied temporarily in-place, executed against its targeted Vitest suite (`refunds.spec.ts`), confirmed to fail (`exit 1`), and immediately restored cleanly:

| #     | Mutation Applied                                                                                    | Target File                                                                                                                  | Targeted Test              | Observed Failure Output                                                                                             | Status                |
| ----- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **a** | Replace `RoundingMode.DOWN` with `RoundingMode.HALF_UP` in `computeRefund`                          | [pricing.refund.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/pricing/pricing.refund.ts)             | `refunds.spec.ts -t "AC1"` | `AssertionError: expected '500001' to be '500000'` (`refunds.spec.ts:540`)                                          | **Killed (`exit 1`)** |
| **b** | Remove `CREATE TRIGGER "trg_refunds_over_refund_guard"`                                             | [0016_vengeful_arclight.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0016_vengeful_arclight.sql) | `refunds.spec.ts -t "AC4"` | Second non-failed `INSERT` resolved instead of rejecting `/exceed payment attempt amount/i` (`refunds.spec.ts:822`) | **Killed (`exit 1`)** |
| **c** | Drop `options.tx` from `inventoryService.release(..., options.tx)` inside `cancelConfirmedWithLock` | [booking.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/booking/booking.service.ts)           | `refunds.spec.ts -t "AC4"` | `AssertionError: expected 0 to be 1` — seats released despite cancel tx rollback (`refunds.spec.ts:795`)            | **Killed (`exit 1`)** |
| **d** | Bypass `refund.status === 'succeeded'` guard with per-event `entryKind` in `handleRefundWebhook`    | [refund.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/payments/refund.service.ts)            | `refunds.spec.ts -t "AC5"` | `AssertionError: expected [ row1, row2 ] to have a length of 1` (`refunds.spec.ts:985`)                             | **Killed (`exit 1`)** |
| **e** | Use `new Date(Date.now())` instead of `cancelRes.dbNow` in `cancelConfirmedBooking`                 | [refund.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/payments/refund.service.ts)            | `refunds.spec.ts -t "AC1"` | `AssertionError: expected '0' to be '1000001'` (`refunds.spec.ts:515`, poisoned by `Date.now()` `+100h` spy)        | **Killed (`exit 1`)** |

### Module Boundary Violation Demo (`pnpm lint:boundaries`)

- Temporarily added `import { BookingService } from '../booking/booking.service.js';` to [refund-admin.controller.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/payments/refund-admin.controller.ts):
  ```text
  error no-sibling-module-internal-imports: apps/api/src/modules/payments/refund-admin.controller.ts → apps/api/src/modules/booking/booking.service.ts
  x 1 dependency violations (1 errors, 0 warnings). 147 modules, 677 dependencies cruised.
  ```
- After restoring clean barrel imports (`index.ts`), `pnpm lint:boundaries` passed with:
  ```text
  ✔ no dependency violations found (147 modules, 675 dependencies cruised)
  ```

---

## 4. Monorepo Verification Summary

- `pnpm format:check` — All matched files pass Prettier across workspace packages and `tools`.
- `pnpm lint` — Packages + `apps/api` + `apps/web` + `tools` pass ESLint with 0 errors.
- `pnpm lint:boundaries` — 0 dependency violations across 147 modules / 675 dependencies.
- `pnpm typecheck` & `pnpm build` — Clean exit 0 across all packages and apps.
- `pnpm db:generate` — `No schema changes, nothing to migrate`.
- `DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm test` — All package tests (`money`, `shared`, `time`, `db`, `i18n`), API suite (`17 passed (17)`, `133 passed (133)` including all `9/9` tests in [refunds.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/payments/refunds.spec.ts)), and `tools/check-licenses.spec.ts` (`16 passed (16)`) passed.
- `pnpm licenses:check` — `All 471 package licenses verified successfully.`
- `pnpm audit --prod --audit-level high` — Exit 0 (`0` high/critical vulnerabilities; 1 moderate).

---

## 5. Live Staging E2E Verification (`pay -> cancel -> refund succeeded`)

Rebuilt and deployed staging with `./scripts/staging-up.sh` (running with health probe `200 OK` on Cloudflare tunnel `https://competing-lows-wins-patio.trycloudflare.com`) and executed the full customer flow over HTTPS + Basic Auth:

```text
Staging URL: https://competing-lows-wins-patio.trycloudflare.com
Run ID: ccc4762c
1. Hold created: PQ-JD7X4R9S status=held amount=1250000 VND
2. Checkout initiated: attemptId=01a21d41-39ca-7f47-81c9-55418004b403 redirectUrl=/mock-psp/checkout/mock_84828aca4363456080765c1a536a2b82
3. Paid & confirmed: status=confirmed paymentRef=mock_84828aca4363456080765c1a536a2b82
4. Cancelled: status=cancelled refundPercent=100 refundAmountMinor=1250000
5. Final GET /bookings/PQ-JD7X4R9S: status=cancelled refund={"amountMinor":"1250000","status":"succeeded"}
--- DB Verification ---
Booking & Departure: cancelled|1|0|succeeded|1250000|mref_ad165023a11b45da94186a80a3f65c22
Journal entries for booking/refund:
booking_cancellation|customer_cancellation|liability:customer_prepayments:VND|1250000|0
booking_cancellation|customer_cancellation|liability:refunds_payable:VND|0|1250000
refund|refund_settled|liability:refunds_payable:VND|1250000|0
refund|refund_settled|asset:psp_clearing:mock:VND|0|1250000
Unbalanced entries: 0
ota_app privileges on refunds tables:
payments.mock_psp_refunds|INSERT,SELECT,UPDATE
payments.refunds|INSERT,SELECT,UPDATE
```
