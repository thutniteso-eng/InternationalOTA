# TASK-P2-02 Implementation & Verification Report

## Summary
- **Branch**: `task/P2-02-inventory`
- **Scope**:
  - **Database schema & forward-only migration** ([0010_polite_meltdown.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0010_polite_meltdown.sql), [inventory.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/schema/inventory.ts)):
    - Created PostgreSQL schema `inventory` with tables `inventory.departures` and `inventory.allocations`.
    - `inventory.departures`: FK to `catalog.products`, `local_date date`, `local_time time`, `starts_at timestamptz` computed via PostgreSQL `AT TIME ZONE`, `UNIQUE (product_id, starts_at)`, `CHECK (capacity > 0)`, `CHECK (allocated >= 0 AND allocated <= capacity)`, `CHECK (status IN ('open', 'closed', 'cancelled'))`, `CHECK (booking_cutoff_minutes >= 0)`.
    - `inventory.allocations`: FK to `inventory.departures`, `UNIQUE (departure_id, ref_type, ref_id)`, `CHECK (quantity > 0)`, `CHECK (state IN ('active', 'released'))`, released timestamp consistency constraint.
    - DB invariant verifier function `inventory.verify_allocated()` returning any departures whose `allocated` differs from `SUM(quantity) FILTER (WHERE state = 'active')`.
    - Least-privilege runtime role grants updated in [roles.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/roles.ts) (`USAGE`, `SELECT/INSERT/UPDATE/DELETE`, `USAGE` on sequences, `EXECUTE` on functions for schema `inventory` to `ota_app`).
  - **Inventory module** (`apps/api/src/modules/inventory/`):
    - Atomic conditional `allocate({ departureId, quantity, refType, refId }, tx?)` and idempotent `release({ departureId, refType, refId }, tx?)` inside one DB transaction, using PostgreSQL `now()` clock, ref-scoped transaction advisory locks for race-free idempotency, and typed outcomes (`allocated | sold_out | closed | cutoff_passed | not_found` — never 500).
    - Admin endpoints (`@Roles('admin', 'operator')`, `@Idempotent()` on mutations): `POST /admin/inventory/products/:productId/departures/generate` (≤ 366 days, `tour`/`activity` only, DST non-existent local time rejected with `422`), `GET /admin/inventory/products/:productId/departures`, `PATCH /admin/inventory/departures/:departureId`, `POST /admin/inventory/departures/:departureId/close`, `/reopen`, `/cancel` (returns `activeAllocationsCount`).
    - Public availability endpoint (`GET /catalog/products/:productId/availability?from=YYYY-MM-DD&to=YYYY-MM-DD`, ≤ 62 days): checks public visibility solely via `CatalogService` public API (`getPublicProductVisibility`), hides non-published/suspended products (404), hides past/cutoff/closed/cancelled departures, never exposes allocation refs.
  - **i18n**: Symmetric `inventory.*` message keys added in `packages/i18n/messages/en.json` and `packages/i18n/messages/vi.json`.
- **New Node dependencies**: None (zero new npm packages).

---

## Verbatim Test Output (AC1–AC9)

Run command:
```text
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm --filter @internationalota/api exec vitest run --reporter=verbose src/modules/inventory/inventory.spec.ts
```

Verbatim output:
```text
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC1: Last seat — 50 concurrent allocate requests across 50 parallel DB connections yield 1 allocated and 49 sold_out 1915ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC2: Mixed load — 40 concurrent requests of qty 1..3 against capacity 10 never oversell and satisfy verify_allocated() 1183ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC3: Idempotent concurrent same-ref allocation, quantity-conflict error, and double-release safety 177ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC4: DB CHECK backstops reject invalid allocated/capacity updates (23514) and API rejects capacity below allocated (422) 495ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC5: DB clock cutoff checks, closed/cancelled status outcomes, and not_found handling 596ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC6: Time zone conversion via PostgreSQL AT TIME ZONE and DST non-existent local time rejection (422) 586ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC7: Re-running schedule rule creates 0 duplicates, preserves allocations, enforces 366-day limit, and rejects transfers 936ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC8: Public availability hides draft/archived/suspended products (404), hides past/cutoff/closed/cancelled departures, updates remaining, and leaks no allocation refs 949ms
 ✓ src/modules/inventory/inventory.spec.ts > Inventory module integration tests (P2-02) > AC9 & write-isolation invariant: auth guards (401/403), @Idempotent replay, and allocated column is written only inside inventory module 297ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

---

## Mutation Evidence (AC10)

| Mutation | Change applied temporarily | Killed by | Verbatim failure excerpt |
|---|---|---|---|
| **10(a)** Remove `AND allocated + $q <= capacity` from conditional `UPDATE` | Removed capacity guard predicate in `InventoryService.allocate` | `AC1` & `AC2` | `Caused by: error: new row for relation "departures" violates check constraint "departures_allocated_check"` (`code: '23514'`, 2 failed) |
| **10(b)** Remove `departures_allocated_check` CHECK constraint | Removed `CONSTRAINT "departures_allocated_check"` from `0010_polite_meltdown.sql` in isolated temp DB | `AC4` | `AssertionError: expected undefined to be '23514' // Object.is equality` |
| **10(c)** Replace DB `now()` with `+2h` shifted app-side `new Date()` | Substituted `${shiftedNowIso}::timestamptz` in `InventoryService.allocate` | `AC5` | `AssertionError: expected 'cutoff_passed' to be 'allocated' // Object.is equality` |
| **10(d)** Remove idempotency lookup on `inventory.allocations` | Disabled `if (foundAlloc)` short-circuit in `InventoryService.allocate` | `AC3` | `Caused by: error: duplicate key value violates unique constraint "allocations_departure_ref_unique"` (`code: '23505'`) |

---

## Boundaries, Staging & Workspace Verification (AC11)

### `pnpm lint:boundaries` deliberate violation test & clean state
With temporary internal import `import type { InventoryService } from '../inventory/inventory.service.js';` added to `apps/api/src/modules/catalog/catalog.service.ts`:
```text
$ pnpm lint:boundaries

  error no-sibling-module-internal-imports: apps/api/src/modules/catalog/catalog.service.ts → apps/api/src/modules/inventory/inventory.service.ts

x 1 dependency violations (1 errors, 0 warnings). 111 modules, 396 dependencies cruised.

ELIFECYCLE Command failed with exit code 1.
```
After reverting back to public API imports only:
```text
$ pnpm lint:boundaries

✔ no dependency violations found (111 modules, 395 dependencies cruised)
```

### Staging deployment (`./scripts/staging-up.sh`) & `ota_app` runtime grants
- Live tunnel URL: `https://church-supplier-cooked-blogs.trycloudflare.com`
- Health probe: `GET /api/health/ready -> 200 OK`
- Public availability checks through Caddy + Cloudflare tunnel:
```text
HTTP/2 404
content-type: application/problem+json; charset=utf-8
{"type":"https://httpstatuses.com/404","title":"Không tìm thấy","status":404,"detail":"Không tìm thấy sản phẩm.","code":"catalog.product.notFound","i18nKey":"catalog.product.notFound","requestId":"01a21506-2af7-7e89-b667-061a948d9783"}
HTTP_STATUS:404

HTTP/2 400
content-type: application/problem+json; charset=utf-8
{"type":"https://httpstatuses.com/400","title":"Yêu cầu không hợp lệ","status":400,"detail":"Tham số tồn kho không hợp lệ: date window of 91 days exceeds maximum of 62 days.","code":"inventory.query.invalidParams","i18nKey":"inventory.query.invalidParams","requestId":"01a21506-2cc8-77b4-8e3c-db7f9df25030"}
HTTP_STATUS:400
```
- Least-privilege `ota_app` check against `ota_staging`:
```text
$ docker compose -f deploy/staging/compose.yml exec -T -e PGPASSWORD="$OTA_APP_PASSWORD" postgres psql -U ota_app -d ota_staging -c "SELECT current_user, (SELECT COUNT(*) FROM inventory.departures) AS departures_cnt, (SELECT COUNT(*) FROM inventory.allocations) AS allocations_cnt, (SELECT COUNT(*) FROM inventory.verify_allocated()) AS mismatches;"
 current_user | departures_cnt | allocations_cnt | mismatches
--------------+----------------+-----------------+------------
 ota_app      |              0 |               0 |          0
(1 row)
```

### Full Monorepo & Fresh-Clone Checks
- `pnpm format:check`: passed
- `pnpm lint`: passed
- `pnpm lint:boundaries`: passed (`no dependency violations found (111 modules, 395 dependencies cruised)`)
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm db:generate`: `No schema changes, nothing to migrate` (23 tables)
- `pnpm test`: passed (`apps/api`: 12 files / 90 tests passed, `tools`: 1 file / 16 tests passed, plus all workspace packages)
- `pnpm licenses:check`: passed (`All 471 package licenses verified successfully`)
- `pnpm audit --prod --audit-level high`: passed (exit 0)
