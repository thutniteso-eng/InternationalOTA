# TASK P2-05 — Checkout saga + Mock payment gateway (D-020) + ledger posting

> Roadmap note (D-022): the original P2-05 (saga orchestration) and P2-06 (first PSP adapter + webhooks) are merged into this one task, because the saga *is* the payment flow. A real PSP adapter (VNPay/OnePay) comes later behind the same port.

## OBJECTIVE
A customer with a verified email can pay for a held booking through the **Mock payment gateway**. The booking is confirmed **only** by a verified, deduplicated, amount-checked server-to-server callback, and the payment is posted to the double-entry ledger in the same transaction. Every failure path ends in a defined, consistent state:
- failure;
- duplicate callback;
- late success after expiry;
- amount mismatch;
- lost callback;
- provider down.

## BACKGROUND
Read:
- D-020 (adapters + Mock gateway, secrets never in plaintext DB, config snapshot per attempt, Mock refused in production), D-018 (verified email before payment);
- P1-08 inbox/outbox: `WebhookVerifier` contract, signed `eventId`, raw body, 1 MB cap;
- P1-09 `LedgerService.post(tx, …)` with accounts by `finance.accounts.code`;
- P2-04 booking API: `markPaymentPending`, `confirm(bookingId, paymentRef)` with typed outcomes `not_confirmable` / `conflict`; history actor `system:payment`;
- `deploy/staging/Caddyfile`: `/webhooks/*` bypasses basic auth; everything else is behind it.

## SCOPE
### A. Module `payments` (new schema, forward-only migration)
- **`payments.payment_attempts`:**
  - Columns:
    - `id` (v7), `booking_id`, `provider` (`mock` now), `provider_ref` (NULL until the checkout is created; `UNIQUE (provider, provider_ref)`);
    - `amount_minor bigint CHECK (> 0)`, `currency`, `provider_config_snapshot jsonb` (non-secret config only: provider, mode, version);
    - `status` CHECK IN (`initiated`, `succeeded`, `failed`, `refund_required`, `expired`);
    - `failure_reason NULL`, `version`, `created_at`, `completed_at NULL`.
  - **DB-guarded transitions** (trigger, same pattern as P2-04 incl. immutable core columns and version bump):
    - `initiated → succeeded | failed | refund_required | expired`;
    - all other states are terminal.
  - Partial unique index: **at most one `succeeded` attempt per booking**.
  - At most 3 attempts per booking, checked under a booking row lock.
- **Port** `PaymentProvider`:
  - `createCheckout({attemptId, amountMinor, currency, locale, returnUrl}) → {providerRef, redirectUrl}`;
  - `verifyWebhook(rawBody, headers) → {eventId, providerRef, outcome: 'succeeded'|'failed', amountMinor, currency, occurredAt}` (implements the P1-08 `WebhookVerifier` contract);
  - `getStatus(providerRef) → same shape | 'pending'`.
  - Provider is selected by config, and adapters are registered in a provider registry.
- **Mock adapter:**
  - Secret from env `MOCK_PSP_SECRET` (≥ 32 chars; missing → mock adapter not registered, logged).
  - **Refuses to register when `APP_ENV=production`.** Test this.
  - Hosted page `GET /mock-psp/checkout/:providerRef`: simple HTML, vi/en, shows the amount formatted via P1-11 and the booking reference. Buttons:
    - **Pay successfully**;
    - **Fail payment**;
    - **Cancel / go back** (no callback);
    - dev panel: **Success + duplicate callback**, **Success delivered after 3 minutes** (pg-boss delayed job), **Success with wrong amount**.
  - On click it builds the callback JSON (`eventId` = random UUID inside the signed body; `occurredAt`), signs `HMAC-SHA256(secret, timestamp + "." + rawBody)` with headers `x-mock-signature` and `x-mock-timestamp`, POSTs it to `/webhooks/mock-psp` (internal URL, server-side) and redirects the browser to `returnUrl`.
  - `verifyWebhook` checks the signature in constant time over the raw bytes and rejects a timestamp skew greater than 5 min.
  - `getStatus` reads the mock's own state table `payments.mock_psp_transactions`. Only the mock adapter writes it.

### B. Checkout saga (orchestration in the `payments` module; booking/finance/identity only via their public APIs)
1. **`POST /bookings/:reference/checkout`** (customer owner, `@Idempotent()`):
   - Preconditions: email verified (D-018), booking `held` or `payment_pending`, hold not expired (DB clock), fewer than 3 attempts.
   - **Tx1:** `markPaymentPending` (if `held`) and insert an attempt `initiated` with the amount/currency from the booking.
   - Call `provider.createCheckout` **outside** any DB transaction, with a 10 s timeout.
   - **Tx2:** store `provider_ref`. Return `{redirectUrl}`.
   - Provider error/timeout → the attempt becomes `failed` (`provider_unavailable`) and the endpoint returns 502 with an `i18nKey`. The customer may retry; the booking stays `payment_pending` until its hold expires.
2. **Webhook handling** (the inbox handler for provider `mock`), in **one transaction**:
   - lock the attempt `FOR UPDATE`, then the booking via the booking API;
   - **Amount/currency ≠ attempt** → attempt `failed` (`amount_mismatch`), outbox `payment.amount_mismatch`, error log. **Never confirm.**
   - **`failed`** → attempt `failed`. The booking is unchanged (the customer can retry until expiry).
   - **`succeeded`** → call `booking.confirm(bookingId, providerRef)`:
     - **ok** → attempt `succeeded`, then post the ledger entry: **Dr `asset:psp_clearing:mock:<CUR>`**, **Cr `liability:customer_prepayments:<CUR>`** (create accounts on first use or seed them; amount = attempt amount), then outbox `payment.succeeded`;
     - **`not_confirmable`** (booking expired/cancelled) → attempt `refund_required`, then post **Dr `asset:psp_clearing:mock:<CUR>`**, **Cr `liability:refunds_payable:<CUR>`**, then outbox `payment.refund_required`. Seats are **not** re-allocated. The actual refund is P2-07.
     - **`conflict`** (already confirmed by another attempt) → treat as above: `refund_required` (a double payment) with the same ledger entry.
   - **Duplicate callbacks** are deduped by the inbox via the signed `eventId`. A second distinct event for an already-terminal attempt is a no-op with an info log, and never a second ledger posting.
3. **Reconciliation job** (pg-boss, every 5 min):
   - attempts `initiated` for more than 20 min are checked with `provider.getStatus` and finalised through the **same** handler path (lost-callback recovery);
   - attempts still pending after 60 min → `expired`.
4. **`GET /bookings/:reference`** additionally returns `payment: {status, attemptCount}` (owner only). The web return page (P2-09) will poll it; it never trusts redirect parameters.

### C. Staging
- Caddy: `/mock-psp/*` goes to api behind basic auth (customers on staging already pass it).
- `MOCK_PSP_SECRET` is generated into `.env.staging` by `staging-up.sh` (never committed).
- The internal callback URL is `http://api:4000/webhooks/mock-psp`.

## OUT OF SCOPE
Real PSPs, refunds execution and customer cancellation after confirmation (P2-07), emails (P2-08), booking/checkout UI (P2-09), admin payment UI, partial payments, multi-currency FX, payouts to suppliers.

## ACCEPTANCE CRITERIA (integration tests, isolated temp DB; Mock driven programmatically and via its HTML endpoints)
1. **Happy path:** hold → checkout → mock success. The booking is `confirmed`, `payment_ref = providerRef`, the attempt `succeeded`, the ledger has exactly one balanced entry with Dr clearing / Cr prepayments = total, the outbox has `booking.confirmed` and `payment.succeeded`, and history has `payment_pending → confirmed` by `system:payment`.
2. **Duplicate:** the same signed callback delivered 5× concurrently → one confirmation and one ledger entry. A second *distinct* success event for the same attempt is a no-op.
3. **Late success:** the hold expires (`expireDue`), then a success callback arrives → booking stays `expired`, the attempt is `refund_required`, the ledger has Dr clearing / Cr refunds_payable, inventory `allocated` is unchanged (seats still released) and `verify_allocated()` is empty.
4. **Race:** callback vs `expireDue` at the expiry instant, 20 runs. Each run ends either `confirmed` + prepayment posting + seats held, or `expired` + `refund_required` + refunds_payable posting + seats released. Never both, never neither.
5. **Amount mismatch:** the booking is not confirmed, the attempt is `failed` (`amount_mismatch`), there is no ledger entry and the outbox has the event.
6. **Security:**
   - bad signature, missing headers, timestamp skew > 5 min, or a body > 1 MB → 4xx, nothing written to the inbox or state;
   - the Mock adapter is absent when `APP_ENV=production` (`/mock-psp/*` returns 404 and checkout returns 503 `no_provider`).
7. **Lost callback:** success recorded in the mock but the callback is never sent → the reconciliation job confirms it (same postings).
8. **Provider down:** `createCheckout` throws or times out → 502, attempt `failed`, and a retry creates attempt #2. A 4th attempt → 409.
9. **D-018 and ownership:** an unverified email → 403/422 `email_not_verified`; another customer → 404; an expired hold → 409.
10. **Two successes on two attempts of the same booking:** the first confirms; the second becomes `refund_required` (double payment) with the ledger entry. The DB partial unique index prevents two `succeeded` attempts (raw SQL test).
11. **Ledger:** after the whole suite, every journal entry balances per currency (P1-09 triggers) and account balances match the expected totals in a final assertion.
12. **Mutation evidence** (each kills ≥ 1 test):
    - (a) skip the amount check;
    - (b) remove the inbox dedup (use an unsigned id);
    - (c) post the ledger entry outside the confirm transaction;
    - (d) drop the attempt transition trigger;
    - (e) remove the production guard on the Mock adapter;
    - (f) drop the one-succeeded-per-booking index.
    Also a `lint:boundaries` violation demo, fresh clone + CI green, and staging with the full happy path executed through the tunnel (show booking reference, attempt status and ledger balances in the report).

## DELIVERABLES
Branch `task/P2-05-checkout-mock-psp`, PR `[P2-05] Checkout saga + Mock payment gateway`, report `reports/TASK-P2-05-report.md` with the sequence diagram (Mermaid), verbatim test output, the mutation table and `git ls-remote` proof.
