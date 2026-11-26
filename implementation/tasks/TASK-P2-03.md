# TASK P2-03 — Pricing & cancellation policy (versioned, snapshot-ready)

## OBJECTIVE
Every bookable departure can be **quoted** exactly: per-passenger-type prices in integer minor units, a seat count, and the cancellation policy that will apply. Prices and policies are **versioned and immutable**, so a booking (P2-04) can store a snapshot and later detect "price changed before payment" (failure scenario 7). Refunds under a policy are computed by one pure, tested function.

## BACKGROUND
P2-01 (catalog) and P2-02 (inventory) are merged.
- Read `CLAUDE.md` rule 4 (money = integer minor units + ISO 4217; bookings keep snapshots).
- Read `packages/money` (`createMoney`, `multiplyByInt`, `sum`, `roundFraction`, `RoundingMode`).
- Read P1-07 `@Idempotent()` and the P1-12 runtime grants.
- Demo prices, age bands and policies are in `implementation/demo-data/phu-quoc-demo-catalog.json`.
- Carry-over **L1 from P2-02** is part of this task (section E).

## SCOPE
### A. Schema (new schema `pricing`, forward-only migration)
- **`pricing.price_lists`** (insert-only):
  - Columns: `id` (v7), `product_id` FK, `version int` (`UNIQUE (product_id, version)`, assigned as max+1 under a row lock or advisory lock), `currency char(3)` (FK/validated against supported ISO 4217 currencies), `valid_from date`, `valid_to date NULL` (product-local dates, `CHECK valid_to IS NULL OR valid_to >= valid_from`), `created_by`, `created_at`.
  - **Resolution rule:** for a departure's `local_date`, the applicable list is the **highest version** whose date range contains that date. No overlap constraint is needed, and a new version simply overrides.
  - All versions of one product must use the **same currency**: a trigger rejects a different currency (23514 or a custom SQLSTATE, documented).
- **`pricing.price_list_items`** (insert-only):
  - Columns: `price_list_id` FK, `pax_type` CHECK IN (`adult`, `child`, `infant`), `amount_minor bigint CHECK (>= 0)`, `min_age smallint`, `max_age smallint NULL`, `occupies_seat boolean`.
  - `PK (price_list_id, pax_type)`. A list must contain `adult`; the service validates that age bands do not overlap.
- **`pricing.cancellation_policies`** (insert-only, versioned like price lists):
  - Columns: `id`, `product_id`, `version`, `rules jsonb`, `weather_clause text NULL`, `created_at`.
  - `rules` is an array of `{ hoursBeforeStart: int >= 0, refundPercent: int 0..100 }`. The service enforces:
    - sorted by `hoursBeforeStart` descending;
    - `refundPercent` non-increasing as hours decrease;
    - a rule with `hoursBeforeStart = 0` is mandatory;
    - at most 10 rules.
  - A DB CHECK enforces at least `jsonb_typeof(rules) = 'array'`.
  - The current policy is the highest version.
- **Immutability:** `UPDATE`, `DELETE` and `TRUNCATE` on all three tables are blocked by triggers (pattern from P1-09). Test this with raw SQL.
- Grants for `ota_app`: `SELECT, INSERT` only (no `UPDATE`/`DELETE`), via the runtime-grants mechanism.

### B. Module `apps/api/src/modules/pricing/` (public API in `index.ts`)
- **`quote({ departureId, pax: { adult, child, infant } })`** returns either a typed error or a `QuoteSnapshot` containing:
  - `productId`, `departureId`, `startsAt`, `localDate`, `currency`;
  - `lines[]` (`paxType`, `quantity`, `unitAmountMinor`, `lineAmountMinor`), `totalAmountMinor` (string-encoded bigint in JSON);
  - `seats` (sum of quantities whose `occupies_seat` is true);
  - `priceListId` + `priceListVersion`, `cancellationPolicyId` + `cancellationPolicyVersion` + a copy of its `rules`;
  - `quotedAt` (DB clock) and `snapshotHash` (SHA-256 of the canonical JSON excluding `quotedAt`).
  - Typed errors: `no_price` (no list covers the date), `no_policy`, `pax_type_not_offered`, `invalid_pax` (at least 1 adult; total pax 1..50; integers), `departure_not_found`.
  - Reads inventory **only** through the inventory module's public API.
  - Arithmetic only via `packages/money`; no JS `number` for amounts.
- **`computeRefund({ rules, startsAt, cancelledAt, paidAmountMinor, currency })`**, pure:
  - The applicable rule is the one with the largest `hoursBeforeStart` such that `startsAt - cancelledAt >= hoursBeforeStart` hours. Cancelling after the start gives 0%.
  - Amount: `roundFraction(paid × percent, 100, RoundingMode.FLOOR)`, i.e. rounding never favours the platform beyond one minor unit. Document this as the rule.
  - Returns `{ refundPercent, refundAmountMinor, ruleApplied }`.
- **`isSameQuote(a, b)`**: compares `snapshotHash`. P2-04 uses it to require reconfirmation.

### C. Admin API (roles `admin`/`operator`, `@Idempotent()`)
- Create a price list version (with items), list versions for a product, create a cancellation policy version, list policy versions.
- Validation errors return 422 with an `i18nKey` (vi/en messages).

### D. Public API (no auth)
- **`GET /catalog/products/:productId/quote?departureId=&adult=&child=&infant=`** returns the `QuoteSnapshot` without internal ids.
  - Keeps `priceListVersion` and `cancellationPolicyVersion`. Hides `created_by`.
  - Only for publicly visible products and bookable departures (P2-02 visibility rules); otherwise 404.
  - Amounts are also returned formatted for the resolved locale via P1-11 (`formatMoney`), e.g. `950.000 ₫` (vi) / `₫950,000` (en).
- **Public product detail (P2-01)** gains `fromPrice` (lowest `adult` amount across applicable price lists for the next 62 days of open departures, or `null`) and `cancellationSummary` (the current policy rules).
  - Use the catalog → pricing public API direction that `lint:boundaries` allows. If it would create a cycle, put the composition in a thin read-only endpoint in the pricing module and document it.

### E. Carry-over from P2-02
- **L1:** the P2-01 product update returns 422 (`i18nKey`) when `timeZone` changes and the product has any departure. Inventory exposes `hasDepartures(productId)` in its public API. Test it.

## OUT OF SCOPE
Booking/holds (P2-04), payments, taxes/fees breakdown and invoices, promotions/discount codes, currency conversion for display (FX), per-departure price overrides, dynamic pricing, child age verification.

## ACCEPTANCE CRITERIA (integration tests, isolated temporary DB)
1. **Exact arithmetic:** with adult 950000 VND, child 650000 VND and infant 0, the pax mix 2/1/1 gives total `2550000`, `seats = 3` (infant `occupies_seat = false`). A USD list (exponent 2) with adult `12345` × 3 gives `37035`. No float appears anywhere (the ESLint float ban from P1-04 stays green).
2. **Version resolution:** v1 covers all of 2026-12; v2 covers 2026-12-20..2026-12-31. A departure on 12-10 uses v1; a departure on 12-24 uses v2. Adding v3 changes the quote's `snapshotHash`, and `isSameQuote` returns false.
3. **Immutability:** raw SQL `UPDATE`/`DELETE`/`TRUNCATE` on all 3 tables fails. `ota_app` has no `UPDATE`/`DELETE` privilege (query `information_schema.role_table_grants`).
4. **Currency lock:** creating a v2 in USD for a product whose v1 is in VND fails both at the API (422) and through raw SQL (trigger).
5. **Policy validation:** non-monotonic rules, a missing 0-hour rule, refund > 100, unsorted rules and more than 10 rules each give 422 with an `i18nKey`.
6. **Refund table test** (rules 48h → 100%, 24h → 50%, 0h → 0%; paid 1,000,001 VND), for cancellation at:
   - exactly 48h before → 100%;
   - 47h59m before → 50% → `500000` (floor);
   - exactly 24h before → 50%;
   - 1 min before → 0%;
   - after start → 0%.
   Also a USD case with paid 999 at 50% → `499`.
7. **Quote errors:**
   - no list for the date → `no_price`;
   - `child` requested when the list has no child item → `pax_type_not_offered`;
   - 0 adults → `invalid_pax`;
   - 51 pax → `invalid_pax`;
   - a draft product's departure through the public endpoint → 404.
8. **Public output:** raw JSON contains `priceListVersion` but not `priceListId`/`created_by`. vi and en formatting are as specified. `fromPrice` is null when no prices exist and correct otherwise.
9. **L1:** a time-zone change is rejected when departures exist and allowed when none exist.
10. **Auth:** customer → 403 and anonymous → 401 on admin endpoints. Idempotent replay returns the same version, with no duplicate version created.
11. **Mutation evidence** (each makes at least one test fail):
    - (a) refund rounding `FLOOR` → `HALF_UP`;
    - (b) resolution picks the lowest version instead of the highest;
    - (c) dropping the immutability trigger;
    - (d) `seats` counting infants;
    - (e) removing the currency-lock trigger.
    Add a `lint:boundaries` violation demo. Fresh clone + CI green; staging migrate and grants work.

## DELIVERABLES
Branch `task/P2-03-pricing`, PR `[P2-03] Pricing & cancellation policy`, report `reports/TASK-P2-03-report.md` with verbatim test output, the mutation table and `git ls-remote` proof.
