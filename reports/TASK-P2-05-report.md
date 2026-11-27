# TASK P2-05 Report — Checkout Saga, Mock Payment Gateway (D-020) & Ledger Posting

## 1. Summary of Changes

Implemented the checkout orchestration saga, pluggable `PaymentProvider` port, `MockPaymentProvider` simulator with HMAC-signed callbacks and hosted HTML checkout page, transactional webhook/reconciliation processing, and atomic double-entry ledger postings per `D-020` and `D-022` without adding any Node dependencies.

### Database & Migrations (Forward-Only)
- `packages/db/src/schema/payments.ts` & `packages/db/migrations/0015_polite_wind_dancer.sql`:
  - Created schema `payments` with `payments.payment_attempts` and `payments.mock_psp_transactions`.
  - Constraints & indexes on `payment_attempts`: `UNIQUE (provider, provider_ref)`, partial unique index `payment_attempts_one_succeeded_per_booking_idx` (`UNIQUE (booking_id) WHERE status = 'succeeded'`), `CHECK (amount_minor > 0)`, `CHECK (version > 0)`, `completed_at` consistency check, and booking/status indexes.
  - `BEFORE UPDATE` trigger `trg_payment_attempts_transition` (`payments.trg_fn_payment_attempts_transition`): enforces strict `version = OLD.version + 1`, immutable core columns (`id`, `booking_id`, `provider`, `amount_minor`, `currency`, `provider_config_snapshot`, `created_at`), single-write `provider_ref` while `initiated`, and terminal state finality (`initiated -> succeeded | failed | refund_required | expired`).
- `packages/db/src/roles.ts`: granted `USAGE` on `payments` schema and least-privilege `SELECT, INSERT, UPDATE` on `payments.payment_attempts` and `payments.mock_psp_transactions` to `ota_app` (no `DELETE`, `TRUNCATE`, or DDL).

### Modules & Saga
- **`apps/api/src/modules/payments/`**:
  - `PaymentProvider` port (`createCheckout`, `verify`/`verifyWebhook`, `getStatus`) and `PaymentProviderRegistry`.
  - `MockPaymentProvider` & `MockPspController`: reads `MOCK_PSP_SECRET` (>= 32 chars), **refuses to register when `APP_ENV=production`** (returning 404 on `/mock-psp/*` and `/webhooks/mock-psp`, 503 `no_provider` on checkout), serves bilingual `vi`/`en` HTML checkout page (`GET /mock-psp/checkout/:providerRef`) with P1-11 formatted amount and interactive + dev-panel actions (`success`, `fail`, `cancel`, `duplicate`, `delayed_3m`, `wrong_amount`), signs `HMAC-SHA256(secret, timestamp + "." + rawBody)` with 5-minute replay window verification over raw bytes.
  - `PaymentsService` & `PaymentsController` (`POST /bookings/:reference/checkout`, `@Idempotent()`):
    - **Tx1:** locks booking via `BookingService.prepareForCheckout`, checks ownership, D-018 (`emailVerified`), DB clock expiry, `< 3` attempts, marks `payment_pending`, creates `initiated` attempt.
    - Outside tx: calls `provider.createCheckout` with 10s timeout; on failure/timeout marks attempt `failed` (`provider_unavailable`) and returns `502` with `i18nKey: payments.checkout.providerUnavailable`.
    - **Tx2:** stores `provider_ref` and enqueues `payment.initiated`.
    - **Atomic webhook & reconciliation handler:** locks attempt `FOR UPDATE`, validates amount/currency (`amount_mismatch` on mismatch, `failed` on provider failure), calls `BookingService.confirm(bookingId, providerRef, { tx })` and posts ledger entry (`Dr asset:psp_clearing:mock:<CUR>` / `Cr liability:customer_prepayments:<CUR>`, or `Cr liability:refunds_payable:<CUR>` on `not_confirmable`/`conflict`) + outbox inside the same PostgreSQL transaction.
  - `pg-boss` queues: scheduled `payment-reconciliation` (`*/5 * * * *`) recovers `initiated > 20m` attempts via `getStatus` and expires `> 60m` attempts; `mock-psp-delayed-callback` handles `delayed_3m`; `WebhooksController` wakes `inbox-relay` immediately after accepting non-test webhooks.
- **Cross-module API & Staging:**
  - `BookingService` supports optional `tx` on `markPaymentPending`/`confirm`, `prepareForCheckout`, and attaches `payment: { status, attemptCount }` to `GET /bookings/:reference` via `BOOKING_PAYMENT_SUMMARY_PORT`.
  - `LedgerService.ensureAccount(tx, ...)` creates clearing/prepayments/refunds_payable accounts idempotently by code.
  - Updated `deploy/staging/Caddyfile` (`/mock-psp/*` behind Basic Auth), `deploy/staging/compose.yml` (`MOCK_PSP_CALLBACK_URL=http://api:4000/webhooks/mock-psp`), and `scripts/staging-up.sh` (`MOCK_PSP_SECRET` generation).

---

## 2. Checkout Saga Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant API as PaymentsController / Service
    participant Booking as BookingService (booking schema)
    participant PSP as MockPaymentProvider / HTML Page
    participant Webhook as WebhooksController / InboxService
    participant Ledger as LedgerService (finance schema)

    Customer->>API: POST /bookings/:reference/checkout (Idempotency-Key)
    API->>Booking: Tx1: prepareForCheckout(ref, userId, tx) [FOR UPDATE]
    Note over API,Booking: Checks owner, D-018, DB expiry, <3 attempts; held -> payment_pending
    API->>API: Tx1: INSERT payments.payment_attempts (status=initiated)
    API->>PSP: Outside Tx (10s timeout): createCheckout(...)
    PSP-->>API: { providerRef, redirectUrl }
    API->>API: Tx2: UPDATE payment_attempts SET provider_ref, version+1 + outbox
    API-->>Customer: 200 { attemptId, providerRef, redirectUrl }

    Customer->>PSP: GET /mock-psp/checkout/:providerRef (bilingual HTML)
    Customer->>PSP: POST /mock-psp/checkout/:providerRef/action (action=success)
    PSP->>Webhook: POST /webhooks/mock-psp (HMAC-SHA256 + x-mock-timestamp)
    PSP-->>Customer: 303 Redirect to returnUrl
    Webhook->>Webhook: Verify rawBody HMAC & replay window (<=5m); INSERT platform.inbox_messages (dedup)

    Webhook->>API: Inbox relay savepoint tx: handleProviderInboxMessage(msg, tx)
    API->>API: SELECT payment_attempts FOR UPDATE (check amount/currency)
    API->>Booking: confirm(bookingId, providerRef, { tx }) [FOR UPDATE]
    alt Booking payment_pending -> confirmed (ok)
        API->>API: UPDATE payment_attempts -> succeeded
        API->>Ledger: post(tx): Dr asset:psp_clearing:mock:CUR / Cr liability:customer_prepayments:CUR
    else Hold expired/cancelled (not_confirmable) or double pay (conflict)
        API->>API: UPDATE payment_attempts -> refund_required
        API->>Ledger: post(tx): Dr asset:psp_clearing:mock:CUR / Cr liability:refunds_payable:CUR
    end
    Customer->>Booking: Poll GET /bookings/:reference -> status + payment: {status, attemptCount}
```

---

## 3. Verbatim Test & Verification Output

### `payments.spec.ts` (Isolated Temp PostgreSQL DB)
```text
 ✓ src/modules/payments/payments.spec.ts (10 tests) 9586ms
   ✓ Checkout saga & Mock PSP adapter (P2-05) (10)
     ✓ AC1 & Mutation (c): Happy path via Mock PSP HTML, atomic ledger posting, outbox, and transactional rollback check  387ms
     ✓ AC2 & Mutation (b): Duplicate signed callbacks (5x concurrent + unsigned header variants) and distinct second event are no-op 192ms
     ✓ AC3: Late success after hold expiry sets attempt refund_required, posts refunds_payable, and leaves seats released 203ms
     ✓ AC4: Callback vs expireDue race at expiry instant across 20 runs always picks exactly one consistent outcome  5304ms
     ✓ AC5 & Mutation (a): Amount mismatch fails attempt, leaves booking payment_pending, writes zero ledger, enqueues outbox 170ms
     ✓ AC6 & Mutation (e): Rejects bad signatures, missing headers, timestamp skew > 5m, >1MB body, and disables Mock PSP in production 230ms
     ✓ AC7: Reconciliation recovers lost callbacks after 20m, expires pending attempts after 60m, and handles cancel/delayed actions  444ms
     ✓ AC8 & AC9: Provider error -> 502 retryable up to 3 attempts, 4th -> 409; D-018/ownership/expired hold enforced  686ms
     ✓ AC10 & Mutations (d, f): Double payment puts 2nd attempt in refund_required; partial index & trigger block raw SQL tampering + ota_app grants  479ms
     ✓ AC11: Every journal entry balances per currency and all payment ledger account balances match expected totals 11ms
```

### Full Monorepo Verification
- `pnpm format:check`: passed
- `pnpm lint`: passed
- `pnpm lint:boundaries`: `✔ no dependency violations found (144 modules, 633 dependencies cruised)`
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm db:generate`: passed (`30 tables`, `No schema changes, nothing to migrate`)
- `pnpm test` (`DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev"`):
  - `@internationalota/api`: `16` test files / `123` tests passed (0 failed, 0 skipped)
  - `@internationalota/web`: `2` test files / `8` tests passed
  - `packages/*`: `shared` `2`, `db` `19`, `money` `41`, `i18n` `21`, `time` `22` passed; `tools` `16` passed
- `pnpm licenses:check`: `All 471 package licenses verified successfully`
- `pnpm audit --prod --audit-level high`: exited 0

---

## 4. Mutation Evidence (a–f) & Module Boundary Violation Demo

| Mutation | Description | Exit Code | Killed Test & Assertion |
| --- | --- | --- | --- |
| **(a)** | Skip amount/currency check in `PaymentsService` (`if (false)`) | `1` | `AC5`: `AssertionError: expected 'confirmed' to be 'payment_pending'` (`payments.spec.ts:811`) |
| **(b)** | Remove signed `eventId` dedup in `MockPaymentProvider.verify` (use unsigned `x-mock-event-id` header) | `1` | `AC2`: `AssertionError: expected [ ... ] to have a length of 1 but got 5` (`payments.spec.ts:618`) |
| **(c)** | Call `bookingService.confirm(...)` without `{ tx }` so ledger posts outside confirm transaction | `1` | `AC1` & `AC11`: transactional rollback & balance check failed (`payments.spec.ts:1327`, `expected 850000n to be 1700000n`) |
| **(d)** | Drop `trg_payment_attempts_transition` from `0015` | `1` | `AC10`: raw SQL `UPDATE payments.payment_attempts SET status = 'failed'` resolved instead of rejecting (`payments.spec.ts:1267`) |
| **(e)** | Remove `APP_ENV=production` guard on `MockPaymentProvider` | `1` | `AC6`: `GET /mock-psp/checkout/mock_any` returned `500` instead of `404` (`payments.spec.ts:955`) |
| **(f)** | Drop `payment_attempts_one_succeeded_per_booking_idx` partial unique index from `0015` | `1` | `AC10`: raw SQL second `succeeded` insert resolved instead of rejecting (`payments.spec.ts:1277`) |

### `lint:boundaries` Violation Demo
Temporarily importing `../booking/booking.service.js` directly inside `apps/api/src/modules/payments/payments.controller.ts` caused `pnpm lint:boundaries` to fail (`EXIT=1`):
```text
  error no-sibling-module-internal-imports: apps/api/src/modules/payments/payments.controller.ts → apps/api/src/modules/booking/booking.service.ts

x 1 dependency violations (1 errors, 0 warnings). 144 modules, 634 dependencies cruised.
```

---

## 5. Staging Happy Path Execution Through Tunnel

- **Live tunnel URL:** `https://processor-society-celebrate-efficiently.trycloudflare.com` (`/api/health/ready -> 200 OK`)
- **End-to-end flow over HTTPS tunnel (Basic Auth + verified staging user + demo tour):**
```text
Hold created: reference=PQ-RYZC7EVX, amount=750000 VND
Checkout initiated: attemptId=01a21d08-e42b-78bc-a3cc-e23390a8ad13, providerRef=mock_690988efe49e436daf0c7bcab5595e7d, redirectUrl=/mock-psp/checkout/mock_690988efe49e436daf0c7bcab5595e7d
Mock PSP HTML page status=200, contains reference=PQ-RYZC7EVX
Mock PSP action=success status=303, location=/vi/bookings/PQ-RYZC7EVX
Confirmed via tunnel! booking.status=confirmed, payment={'status': 'succeeded', 'attemptCount': 1}, paymentRef=mock_690988efe49e436daf0c7bcab5595e7d
```
- **Staging DB state & `ota_app` grants (`ota_staging`):**
```text
      table_name       |       privileges       
-----------------------+------------------------
 mock_psp_transactions | INSERT, SELECT, UPDATE
 payment_attempts      | INSERT, SELECT, UPDATE
(2 rows)

  reference  |  status   | total_amount_minor | currency |              payment_ref              
-------------+-----------+--------------------+----------+---------------------------------------
 PQ-RYZC7EVX | confirmed |             750000 | VND      | mock_690988efe49e436daf0c7bcab5595e7d
(1 row)

                  id                  | provider |             provider_ref              | amount_minor | currency |  status   | version 
--------------------------------------+----------+---------------------------------------+--------------+----------+-----------+---------
 01a21d08-e42b-78bc-a3cc-e23390a8ad13 | mock     | mock_690988efe49e436daf0c7bcab5595e7d |       750000 | VND      | succeeded |       3
(1 row)

                code                |   type    | currency | total_debit | total_credit | net_balance 
------------------------------------+-----------+----------+-------------+--------------+-------------
 asset:psp_clearing:mock:VND        | asset     | VND      |      750000 |            0 |      750000
 liability:customer_prepayments:VND | liability | VND      |           0 |       750000 |      750000
(2 rows)
```
