# TASK P2-04 — Booking aggregate, state machine & expiring holds

## OBJECTIVE
A signed-in customer can place a **hold** on seats of a departure at the quoted price.
- The hold either becomes `payment_pending` → `confirmed` (wired to payment in P2-05/P2-06) or **expires automatically** and returns the seats.
- Every status change is an atomic, DB-guarded transition with an append-only history.
- This is the core of booking correctness: no oversell, no double booking, no lost seats, no silent price change.

## BACKGROUND
Read:
- `CLAUDE.md` rules 1, 4 and 7, D-016, D-018 (verified email required **before payment**, not before hold), D-020;
- `docs/SOLUTION_ARCHITECTURE.md` (module `booking`; cross-module ports section);
- P2-02 `allocate/release` and **limitations L3/L4** on PR #29;
- P2-03 `quote`, `QuoteSnapshot`, `isSameQuote`;
- P1-07 `@Idempotent()`, P1-08 outbox (`OutboxService.enqueue(tx, …)`) and pg-boss `JobQueueService`, P1-10 redaction;
- the `REPOSITORY_REGISTER` HAIP note: lock the row, then do conditional status transitions. We follow the same principle.

## SCOPE
### A. Schema (new schema `booking`, forward-only migration)
- **`booking.bookings`:**
  - `id` (v7), `reference` (unique, human code `PQ-` + 8 Crockford-base32 random chars; retry on collision);
  - `customer_user_id`, `product_id`, `departure_id`, `status`, `pax` jsonb `{adult, child, infant}`, `seats int CHECK (> 0)`;
  - `currency char(3)`, `total_amount_minor bigint CHECK (>= 0)`, `quote_snapshot jsonb NOT NULL`, `snapshot_hash text NOT NULL`;
  - `contact_name`, `contact_email`, `contact_phone`, `contact_locale`;
  - `allocation_ref text NOT NULL` (the inventory `refId`, see B);
  - `hold_expires_at timestamptz NOT NULL`, `payment_ref text NULL`, `version int NOT NULL DEFAULT 1`;
  - `created_at`, `updated_at`, and `confirmed_at` / `expired_at` / `cancelled_at` (NULL).
- **Status set:** `held`, `payment_pending`, `confirmed`, `expired`, `cancelled`.
- **Legal transitions:**
  - `held → payment_pending | expired | cancelled`;
  - `payment_pending → confirmed | expired | cancelled`.
  - `confirmed`, `expired` and `cancelled` are terminal **in this task**; post-confirmation cancellation is P2-07.
  - Enforce in the DB with a `BEFORE UPDATE` trigger that rejects any other transition (custom SQLSTATE or 23514, documented) and requires `version = OLD.version + 1`.
- **Consistency CHECKs:**
  - `confirmed ⇒ payment_ref IS NOT NULL AND confirmed_at IS NOT NULL`;
  - `expired ⇒ expired_at IS NOT NULL`;
  - `cancelled ⇒ cancelled_at IS NOT NULL`.
- **`booking.booking_events`** (insert-only, UPDATE/DELETE/TRUNCATE blocked as in P1-09):
  - columns: `id`, `booking_id`, `from_status NULL`, `to_status`, `actor` (`customer:<id>` | `system:expiry` | `system:payment` | `admin:<id>`), `reason`, `at` (DB clock);
  - a trigger writes the event row on insert and on every status change, so history cannot be skipped.
- **Indexes:**
  - `(status, hold_expires_at)` partial on `held`/`payment_pending`;
  - `(customer_user_id, created_at DESC)`;
  - `(departure_id)`.
- **Grants for `ota_app`:**
  - `bookings`: SELECT/INSERT/UPDATE (no DELETE);
  - `booking_events`: SELECT/INSERT only.

### B. Module `apps/api/src/modules/booking/` (public API in `index.ts`)
- **`createHold({ customer, departureId, pax, contact, expectedSnapshotHash })`**, in **one DB transaction (READ COMMITTED)**:
  1. Re-quote via pricing.
     - If `snapshotHash ≠ expectedSnapshotHash` → typed `price_changed`, returning the new quote; nothing is written. This is failure scenario 7.
  2. Insert the booking row (`held`).
     - `allocation_ref` is set to the booking `id`, which is unique per attempt, satisfying L3.
     - `hold_expires_at = now() + BOOKING_HOLD_MINUTES`: env, default 15, allowed 5–60, validated at boot.
  3. Call `inventory.allocate({departureId, quantity: seats, refType: 'booking', refId: allocation_ref}, tx)`.
     - Any non-`allocated` outcome → roll back the whole transaction and return the typed outcome (`sold_out` | `closed` | `cutoff_passed` | `not_found`).
  4. Enqueue the outbox event `booking.held` in the same transaction.
- **Anti-hoarding:** at most 3 active (`held` / `payment_pending`) bookings per customer, checked under a per-customer advisory lock. Exceeding it → `too_many_active_holds`.
- **`markPaymentPending(bookingId, actor)`:** `held → payment_pending`. It only reads `customer.emailVerified` through the identity public API; unverified → typed `email_not_verified` (D-018). The hold expiry is **not** extended.
- **`confirm(bookingId, paymentRef)`** (internal, for P2-06): `payment_pending → confirmed`.
  - Idempotent: already `confirmed` with the same `payment_ref` → success no-op.
  - Different `payment_ref` → typed `conflict`.
  - `expired` / `cancelled` → typed `not_confirmable` (P2-06 will refund).
- **`cancelBeforePayment(bookingId, customer)`:** `held | payment_pending → cancelled`, releasing the allocation in the same transaction.
- **`expireDue({ limit })`:**
  - selects due bookings with `FOR UPDATE SKIP LOCKED`;
  - for each, transitions to `expired`, calls `inventory.release(…, tx)` and enqueues `booking.expired`, all in one transaction;
  - safe to run from multiple workers concurrently;
  - registered as a pg-boss job every minute via `JobQueueService`.
- **One internal transition helper.** Every transition goes through it:
  - load `FOR UPDATE`, check the legal transition in code, then `UPDATE … SET status, version = version + 1 … WHERE id = $id AND version = $v`;
  - the DB trigger is the backstop.
  - No other code path may `UPDATE booking.bookings`; assert this with a static test, as in P2-02.
- **Multi-departure** bookings are out of scope. If added later, allocate in departure-id order (L4).
- **Clock and logs:** all times use the DB clock. Contact PII must never appear in logs; extend the redaction tests.

### C. HTTP API (customer; requires auth; all mutating endpoints `@Idempotent()`)
- `POST /bookings`:
  - body `{departureId, pax, contact, expectedSnapshotHash}`;
  - `201` returns `{reference, status, holdExpiresAt, totalAmountMinor, currency, quote}`;
  - typed outcomes map to `409` (`price_changed`, `sold_out`, `too_many_active_holds`) or `422` (validation, `closed`, `cutoff_passed`) with an `i18nKey`.
- `POST /bookings/:reference/cancel`.
- `GET /bookings/:reference`: owner only; anyone else gets **404** (no existence leak).
- `GET /me/bookings`: cursor-paginated.
- `POST /bookings/:reference/payment-pending`: a temporary endpoint until P2-06, to exercise D-018. Keep it, but mark it internal in the report.
- **Admin:** `GET /admin/bookings` (filters: status, departure, date range, reference), roles admin/operator, **read-only** in this task.

### D. Web — out of scope (booking UI is P2-09). The detail page keeps the disabled "Book" button.

## OUT OF SCOPE
Payment initiation and webhooks (P2-06), saga/compensation orchestration (P2-05), confirmation emails (P2-08), post-confirmation cancellation and refunds (P2-07), guest checkout, multi-departure baskets, admin mutations, booking UI.

## ACCEPTANCE CRITERIA (integration tests, isolated temp DB, real parallel connections with start barrier)
1. **Last seat:** capacity 1, 50 different customers call `POST /bookings` concurrently. Result: exactly 1 `201` and 49 `409 sold_out`; one booking row; `allocated = 1`; `verify_allocated()` empty.
2. **Double submit:** the same customer sends the same Idempotency-Key twice concurrently, and is then replayed. Result: 1 booking, 1 allocation, identical responses. A different key with the same body creates a second hold, which counts towards the anti-hoarding limit.
3. **Price changed:** quote → admin creates price list v2 → `POST /bookings` with the old hash → `409 price_changed` with the new quote. No booking, no allocation.
4. **Expiry:** a hold with `BOOKING_HOLD_MINUTES` forced short (or `hold_expires_at` moved back via the test DB) → `expireDue` → `expired`, seats released, `booking.expired` in the outbox, and history has `held → expired` by `system:expiry`. Two concurrent `expireDue` workers over 30 due bookings → each expired exactly once; `allocated` back to 0; `verify_allocated()` empty.
5. **Expiry vs confirm race:** a `payment_pending` booking at its expiry instant; run `confirm` and `expireDue` concurrently 20 times. Each run ends in exactly one terminal state, and seats are released **iff** expired. No booking is ever `confirmed` with released seats.
6. **Transitions are DB-guarded:**
   - raw SQL `UPDATE … SET status = 'confirmed'` from `held` fails;
   - `expired → held` fails;
   - an update without a `version` bump fails;
   - `confirmed` without `payment_ref` fails;
   - `booking_events` UPDATE/DELETE fails.
7. **D-018:** an unverified customer gets `markPaymentPending` → `email_not_verified`; once verified it succeeds.
8. **Authorization:**
   - another customer's `GET /bookings/:reference` returns 404, and the same for cancel;
   - anonymous → 401;
   - customer on admin endpoint → 403;
   - `GET /me/bookings` shows only own bookings.
9. **Anti-hoarding:** a 4th active hold → `409 too_many_active_holds`; after cancelling one, the next succeeds. Concurrent 4 holds by one customer → at most 3 succeed.
10. **Cancel before payment** releases seats once, and a second cancel is a no-op success. Cancelling a confirmed booking → 409 (P2-07).
11. **PII:** request/response logs for `POST /bookings` contain no contact email, phone or name (redaction test).
12. **Mutation evidence** (each makes at least one test fail):
    - (a) remove the `version` predicate in the transition helper;
    - (b) drop the transition trigger;
    - (c) remove `SKIP LOCKED` together with the status re-check in `expireDue`;
    - (d) skip the hash comparison in `createHold`;
    - (e) release seats outside the expiry transaction;
    - (f) remove the anti-hoarding advisory lock.
    Also: a `lint:boundaries` violation demo, fresh clone + CI green, and staging migrate/grants plus the expiry job running (show the log line).

## DELIVERABLES
Branch `task/P2-04-booking-holds`, PR `[P2-04] Booking aggregate & holds`, report `reports/TASK-P2-04-report.md` with verbatim test output, the mutation table, the state diagram (Mermaid) and `git ls-remote` proof.
