# TASK P2-02 — Dated inventory: departures & capacity (DB-enforced)

## OBJECTIVE
Each tour or activity has concrete **departures** (date + local start time + capacity). Seats are allocated and released through one atomic primitive that the database itself guarantees can never oversell, never go negative, and never double-allocate for the same reference. This is the inventory truth for booking (P2-04) and failure scenario 1 ("50 concurrent requests for the last seat → exactly 1").

## BACKGROUND
P2-01 merged (PR #27): `catalog.products` with `time_zone` (IANA). Read `CLAUDE.md` rule 1 (inventory truth in PostgreSQL, constraints/row locks, never only cache), `docs/SOLUTION_ARCHITECTURE.md` (module `inventory`), P1-07 `@Idempotent()`, P1-12 runtime grants, D-020 (no external calls). Demo schedules and capacities: `implementation/demo-data/phu-quoc-demo-catalog.json` (`departureTimes`, `capacityPerDeparture`, `operatingDays`).

## SCOPE
### A. Schema (new schema `inventory`, new forward-only migration)
- `inventory.departures`:
  - `id` (v7), `product_id` FK catalog.products, `local_date date`, `local_time time`, `starts_at timestamptz` (computed by the service from `local_date + local_time` in the product's `time_zone`, **using PostgreSQL** `AT TIME ZONE`, not JS date math).
  - `capacity int CHECK (capacity > 0)`, `allocated int NOT NULL DEFAULT 0`, `CHECK (allocated >= 0 AND allocated <= capacity)`.
  - `status` CHECK IN (`open`, `closed`, `cancelled`), `booking_cutoff_minutes int NOT NULL DEFAULT 60 CHECK (>= 0)`, timestamps.
  - `UNIQUE (product_id, starts_at)`.
- `inventory.allocations`:
  - `id`, `departure_id` FK, `quantity int CHECK (> 0)`, `ref_type text`, `ref_id text`, `state` CHECK IN (`active`, `released`), `created_at`, `released_at NULL`.
  - `UNIQUE (departure_id, ref_type, ref_id)`.
- **Invariant:** `departures.allocated = SUM(quantity) of active allocations` for that departure. Both rows change only inside the same transaction in the primitive below. Add a DB-side check function `inventory.verify_allocated()` returning the mismatching departures, used by tests and later by daily reconciliation (P2-10).
- Grants for `ota_app` via the runtime-grants mechanism.

### B. Allocation primitive (module `apps/api/src/modules/inventory/`, public API in `index.ts`)
- `allocate({ departureId, quantity, refType, refId }, tx?)`:
  - One conditional `UPDATE … SET allocated = allocated + $q WHERE id = $id AND status = 'open' AND allocated + $q <= capacity AND now() <= starts_at - cutoff RETURNING …`, followed by insert into `allocations`, in one transaction.
  - Use the **DB clock** (`now()`), never the app clock.
  - Same `(departureId, refType, refId)` again → returns the existing active allocation (idempotent, no second decrement).
  - Same ref with a different quantity → typed error.
  - Result is a typed outcome: `allocated` | `sold_out` | `closed` | `cutoff_passed` | `not_found`. Never a 500.
  - Accepts an optional transaction, so P2-04 can allocate inside the booking transaction.
- `release({ departureId, refType, refId }, tx?)`: active → released, `allocated -= quantity` in the same transaction. Releasing twice or releasing an unknown ref is a no-op success.
- No other code path may modify `allocated` (assert via test that the column is only written in this module; `lint:boundaries` keeps other modules out of `inventory` internals).

### C. Admin API (roles `admin`/`operator`, all mutating endpoints `@Idempotent()`)
- **Generate departures from a schedule rule:**
  - Input: `productId`, `fromDate`, `toDate` (≤ 366 days), `weekdays` (ISO 1–7), `localTimes[]`, `capacity`, `bookingCutoffMinutes`.
  - Re-running the same rule creates no duplicates and leaves existing departures (and their allocations) untouched. The response reports created vs skipped counts.
- **Edit one departure:**
  - Capacity: lowering it below `allocated` → 422 (`i18nKey`). The DB CHECK is the backstop.
  - Close/reopen.
  - Cancel: allowed even with allocations. It only sets the status; refunds and booking side effects are P2-07. The response returns the count of active allocations so staff see the impact.
- **List departures** for a product and date range, with `capacity`, `allocated`, `remaining`.
- Only products whose kind is `tour` or `activity`. `transfer` → 422 (on-request transfers are a later task).

### D. Public API (no auth)
- `GET /catalog/products/:productId/availability?from=YYYY-MM-DD&to=YYYY-MM-DD`:
  - Window ≤ 62 days, dates interpreted in the product's time zone.
  - Returns per departure: `localDate`, `localTime`, `startsAt` (ISO UTC), `remaining`, `status` (`available` | `sold_out`).
  - Only for products visible publicly per P2-01 rules (published, active supplier); otherwise 404 with no existence leak.
  - Hides closed, cancelled, past and cutoff-passed departures.
  - Never exposes allocation refs.
- The route lives in the inventory module but uses catalog only via catalog's public API.

## OUT OF SCOPE
Prices and per-age pricing (P2-03), holds with expiry and the booking aggregate (P2-04), per-resource capacity (boats, guides), private/on-request products, transfers, caching. Do **not** add Redis or any cache for availability.

## ACCEPTANCE CRITERIA (integration tests, isolated temporary DB)
1. **Last seat:** departure with capacity 1; 50 concurrent `allocate` calls with distinct refs, using real parallel connections and a start barrier (prove overlap, as in P1-07). Exactly 1 `allocated` and 49 `sold_out`; final `allocated = 1`; `verify_allocated()` empty.
2. **Mixed load:** capacity 10, 40 concurrent requests of quantity 1–3. Sum of granted quantities ≤ 10, equals `allocated`, and `verify_allocated()` is empty.
3. **Idempotency:** same ref allocated twice concurrently → one allocation row, `allocated` incremented once. Same ref with a different quantity → typed error. Release twice → `allocated` restored once.
4. **DB backstop:** raw SQL `UPDATE inventory.departures SET allocated = capacity + 1` fails with 23514, and so does `allocated = -1`. Reducing capacity below allocated via the API → 422; via raw SQL → 23514.
5. **Cutoff and status** are checked against the DB clock: a departure starting in 30 min with cutoff 60 → `cutoff_passed`. Closed → `closed`. Cancelled → `closed`. Unknown id → `not_found`.
6. **Time zone:** product in `Asia/Ho_Chi_Minh`, local 2026-12-20 08:00 → `starts_at = 2026-12-20T01:00:00Z`. A product in `Europe/Berlin` around the DST change (2027-03-28 02:30 local, a non-existent time) is handled by a documented rule (reject with 422 `i18nKey`) — no silent shift.
7. **Schedule generation:** running the same rule twice → second run creates 0. A 366-day limit is enforced. Existing departures with allocations are unchanged.
8. **Public availability:** hides draft, archived and suspended-supplier products (404), plus past, cutoff, closed and cancelled departures. `remaining` is correct after allocations. Raw JSON contains no `refId`/`refType`.
9. **Auth:** customer → 403 and anonymous → 401 on admin endpoints. Idempotent replay of generate returns the same result.
10. **Mutation evidence** in the report. Each of these must make at least one test fail:
    - (a) removing `allocated + $q <= capacity` from the UPDATE;
    - (b) removing the CHECK constraint (in a test DB);
    - (c) replacing `now()` with an app-side `new Date()` shifted by +2 h;
    - (d) removing the idempotency lookup.
11. `lint:boundaries` fails on a deliberate import of inventory internals from another module (show output). Fresh clone + CI green; `scripts/staging-up.sh` migrates and grants work.

## DELIVERABLES
Branch `task/P2-02-inventory`, PR `[P2-02] Dated inventory`, report `reports/TASK-P2-02-report.md` with verbatim test output, the mutation table and `git ls-remote` proof.
