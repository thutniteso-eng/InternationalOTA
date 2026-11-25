# TASK-P2-01 Implementation & Verification Report

## Summary
- **Branch**: `task/P2-01-catalog`
- **Scope**:
  - Database schemas & migration ([0008_pretty_nicolaos.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0008_pretty_nicolaos.sql)):
    - PostgreSQL extensions `postgis`, `unaccent`, and `pg_trgm` enabled via migration; immutable SQL wrapper `catalog.immutable_unaccent(text)` created for GIN trigram index expression.
    - `supply.suppliers` (`packages/db/src/schema/supply.ts`).
    - `catalog.products` (`geography(Point,4326)` + `GIST` index), `catalog.product_translations` (unique `(product_id, locale)` + unique `(locale, slug)` + `gin_trgm_ops` unaccent index), `catalog.product_images` + DB trigger enforcing max 20 images per product (`packages/db/src/schema/catalog.ts`).
    - Runtime role grants updated in `packages/db/src/roles.ts` (`supply`, `catalog` schema/table/sequence/function grants for `ota_app`).
    - Dev fixtures loader (`pnpm catalog:fixtures` in `packages/db/src/fixtures.ts`) creating 1 `[FAKE]` supplier and 3 `[FAKE]` Phu Quoc products, guarded against `staging`/`production`.
  - NestJS modules & HTTP endpoints:
    - `SupplyModule` (`apps/api/src/modules/supply/`): admin CRUD (`POST /admin/suppliers`, `PATCH /admin/suppliers/:id`, `GET /admin/suppliers`, `GET /admin/suppliers/:id`) and public-safe inter-module lookup methods on `SupplyService`.
    - `CatalogModule` (`apps/api/src/modules/catalog/`): admin draft/translation/image/publish/archive/list/get endpoints (`@Roles('admin')`, `@Idempotent()` on POST) and public catalog endpoints (`GET /catalog/products`, `GET /catalog/products/:locale/:slug`).
    - Shared `@Global()` `I18nModule` (`apps/api/src/common/i18n/i18n.module.ts`), symmetric `vi`/`en` i18n keys (`packages/i18n/messages/{vi,en}.json`), and `ProblemDetailsFilter` propagation of structured `code` / `i18nKey` / `missing` on 4xx responses.
  - Staging deployment fix (`scripts/staging-up.sh`): include `migrate` in `docker compose build api web migrate` so migration/grant updates deploy cleanly on existing staging stacks.
- **New Node dependencies**: None (zero new npm packages added).

---

## Acceptance Criteria Evidence

### AC1 & AC2 & AC7 & AC8 — Admin auth/idempotency, publish invariant, visibility filtering, and no supplier contact leak
Captured from `apps/api/src/modules/catalog/catalog.spec.ts`:
- **AC7**: Unauthenticated admin requests return `401`; non-admin customer requests return `403`; repeating `POST` with identical `Idempotency-Key` replays identical created resource.
- **AC1 & AC2 & AC8**: Publishing a product missing `vi` translation or missing an image fails with HTTP `422` `application/problem+json` containing structured `code`/`i18nKey: "catalog.publish.missing_requirements"` and explicit `missing` items (`translation:vi`, `image`); publishing succeeds once `vi` + ≥1 image exist; `draft`, `archived`, and `suspended`-supplier products never appear in public list or slug detail responses; public payloads contain only `supplierName` and never leak `contactEmail`, `contactPhone`, `legalName`, `taxCode`, or `supplierId`.

### AC3 & AC4 & AC5 & Image Cap & Fixture Guard — i18n slug isolation, accent-insensitive search, PostGIS radius search, 20-image cap, env guard
Captured from `apps/api/src/modules/catalog/catalog.spec.ts`:
- **AC3**: `GET /catalog/products/vi/:enSlug` returns `404`; `GET /catalog/products/vi/:viSlug` and `GET /catalog/products/en/:enSlug` set `Content-Language` and return localized fields; same `slug` in different locales is permitted while duplicate `(locale, slug)` returns `409`; missing `en` translation omits product when `locale=en` is resolved (or uses `Accept-Language` resolution).
- **AC4**: `q=dao ngoc` and `q=Đảo Ngọc` both match `"Chèo SUP Hoàng hôn Phú Quốc"` in Vietnamese, while `q=sunset` does not bleed from English translation into `locale=vi` search results.
- **AC5**: `near=10.2200,103.9600&radiusKm=10` returns Phu Quoc Point (~0–5 km) with ascending `distanceMeters` and excludes mainland Ho Chi Minh City Point (>250 km); expanding to `radiusKm=200` / querying invalid `near`/`radiusKm` returns `400`.
- **Image cap & fixture guard**: Replacing product images with 21 entries is rejected (`422`); setting `http://` URL is rejected (`400`); calling `seedCatalogDevFixtures()` / `pnpm catalog:fixtures` with `APP_ENV=staging` or `production` fails closed.

Verbatim isolated test run (`DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm --filter @internationalota/api exec vitest run --reporter=verbose src/modules/catalog/catalog.spec.ts`):
```text
 ✓ src/modules/catalog/catalog.spec.ts > Supply & Catalog modules integration tests (P2-01) > AC7: anonymous returns 401, customer returns 403 on admin endpoints, and @Idempotent replays identical create response 125ms
 ✓ src/modules/catalog/catalog.spec.ts > Supply & Catalog modules integration tests (P2-01) > AC1 & AC2 & AC8: publish rules enforced with 422 i18nKey; draft/archived/suspended hidden; supplier contacts never leak 336ms
 ✓ src/modules/catalog/catalog.spec.ts > Supply & Catalog modules integration tests (P2-01) > AC3 & AC4 & AC5: i18n slug isolation, accent-insensitive search in resolved locale only, and PostGIS ST_DWithin accuracy 204ms
 ✓ src/modules/catalog/catalog.spec.ts > Supply & Catalog modules integration tests (P2-01) > AC6: stable cursor pagination over 120 products with zero duplicates, zero gaps, and stability under concurrent inserts 6646ms
 ✓ src/modules/catalog/catalog.spec.ts > Supply & Catalog modules integration tests (P2-01) > enforces max 20 https images per product and blocks dev fixtures in staging/production 62ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Fixture CLI guard check:
```text
$ NODE_ENV=staging APP_ENV=staging DATABASE_URL="postgresql://invalid" pnpm catalog:fixtures
Failed to load catalog dev fixtures: Refusing to load dev catalog fixtures in APP_ENV=staging. Only local/test environments are permitted.
ELIFECYCLE Command failed with exit code 1.
```

### AC6 — Cursor pagination stability under concurrent inserts
- Verified across 120 published products paginated at `limit=25` while inserting 3 newer published products mid-walk: 5 pages collected all 120 original items with zero duplicates and zero gaps.

### AC9 — Module boundary enforcement (`pnpm lint:boundaries`)
Deliberate violation test (temporarily replacing `../supply/index.js` with `../supply/supply.service.ts` in `apps/api/src/modules/catalog/catalog.service.ts`):
```text
$ pnpm lint:boundaries

> internationalota@0.0.1 lint:boundaries /home/iteso/projects/InternationalOTA
> depcruise apps/api/src --config .dependency-cruiser.cjs


  error no-sibling-module-internal-imports: apps/api/src/modules/catalog/catalog.service.ts → apps/api/src/modules/supply/supply.service.ts

x 1 dependency violations (1 errors, 0 warnings). 100 modules, 352 dependencies cruised.

ELIFECYCLE Command failed with exit code 1.
```
After reverting back to `../supply/index.js`:
```text
$ pnpm lint:boundaries

> internationalota@0.0.1 lint:boundaries /home/iteso/projects/InternationalOTA
> depcruise apps/api/src --config .dependency-cruiser.cjs


✔ no dependency violations found (100 modules, 352 dependencies cruised)
```

### AC10 — Staging deployment, runtime role grants (`ota_app`), and public tunnel verification
Deployed staging via `./scripts/staging-up.sh`:
- Live tunnel URL: `https://memory-knock-wild-inkjet.trycloudflare.com`
- Health probe: `https://memory-knock-wild-inkjet.trycloudflare.com/api/health/ready -> 200 OK`

Public catalog calls through Caddy + Cloudflare tunnel:
```text
$ curl -sS -u "$STAGING_BASIC_AUTH_USER:$STAGING_BASIC_AUTH_PASSWORD" -D - -w "\nHTTP_STATUS:%{http_code}\n" "https://memory-knock-wild-inkjet.trycloudflare.com/api/catalog/products?locale=vi"
HTTP/2 200
content-type: application/json; charset=utf-8
content-language: vi
{"items":[],"nextCursor":null}
HTTP_STATUS:200

$ curl -sS -u "$STAGING_BASIC_AUTH_USER:$STAGING_BASIC_AUTH_PASSWORD" -D - -w "\nHTTP_STATUS:%{http_code}\n" "https://memory-knock-wild-inkjet.trycloudflare.com/api/catalog/products?locale=en&q=dao&near=10.22,103.96&radiusKm=25"
HTTP/2 200
content-type: application/json; charset=utf-8
content-language: en
{"items":[],"nextCursor":null}
```

Least-privilege `ota_app` verification against `ota_staging`:
```text
$ docker compose -f deploy/staging/compose.yml exec -T -e PGPASSWORD="$OTA_APP_PASSWORD" postgres psql -U ota_app -d ota_staging -c "SELECT current_user, catalog.immutable_unaccent('Đảo Ngọc') AS unaccent_sample, (SELECT COUNT(*) FROM supply.suppliers) AS suppliers_cnt, (SELECT COUNT(*) FROM catalog.products) AS products_cnt, (SELECT COUNT(*) FROM catalog.product_translations) AS translations_cnt, (SELECT COUNT(*) FROM catalog.product_images) AS images_cnt;"
 current_user | unaccent_sample | suppliers_cnt | products_cnt | translations_cnt | images_cnt
--------------+-----------------+---------------+--------------+------------------+------------
 ota_app      | Dao Ngoc        |             0 |            0 |                0 |          0
(1 row)
```

---

## Workspace & Schema Verification
- `pnpm format:check`: passed
- `pnpm lint`: passed
- `pnpm lint:boundaries`: passed (`no dependency violations found (100 modules, 352 dependencies cruised)`)
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm db:generate`: `No schema changes, nothing to migrate` (21 tables)
- `pnpm test`: passed (`apps/api` 11 files / 81 tests passed, plus all workspace packages and `tools`)
- `pnpm licenses:check`: passed (`All 471 package licenses verified successfully`)
- `pnpm audit --prod --audit-level high`: passed (exit 0)

---

## Corrections (R1–R2)

### R1 — Published product invariant + transactional `FOR UPDATE` locking
- **Forward-only migration** (`packages/db/migrations/0009_easy_machine_man.sql` + `packages/db/src/schema/catalog.ts`):
  ```sql
  ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_published_location_check" CHECK (status <> 'published' OR location IS NOT NULL);
  ```
- **Service guards** (`apps/api/src/modules/catalog/catalog.service.ts`):
  - `loadProductRow(id, tx?)` accepts an optional transaction runner and acquires `FOR UPDATE` when called inside a transaction.
  - `updateProduct` runs in a transaction with `FOR UPDATE`, rejecting `{ location: null }` and empty/null/invalid `timeZone` updates on `published` products with HTTP `422` (`i18nKey: "catalog.publish.missingLocation"` / `"catalog.publish.missingTimeZone"`).
  - `publishProduct` runs in a transaction taking `SELECT ... FOR UPDATE` on the product row before running checks and updating status.
- **Automated tests** (`apps/api/src/modules/catalog/catalog.spec.ts`): verified HTTP `422` (`i18nKey` + `code`) when updating `published` product with `location: null` or invalid/`null`/blank `timeZone`, and verified raw SQL `UPDATE catalog.products SET location = NULL WHERE id = $1::uuid` fails with PostgreSQL SQLSTATE `23514`.

### R2 — Geo cursor pagination test + Mutation M2 verification
- Added `R2: geo cursor pagination over 27 products with limit=10 has no duplicates/gaps, non-decreasing distances, and id ASC tie-breaking` in `apps/api/src/modules/catalog/catalog.spec.ts`:
  - Pages through 27 published products within `radiusKm=50` at `limit=10` (plus an outside-radius decoy that is excluded), including 4 products at identical coordinates straddling the page-1/page-2 boundary.
  - Asserts 3 pages, 27 unique IDs, zero duplicates, zero gaps, non-decreasing `distanceMeters`, and deterministic ascending UUID tie-breaking.
- **Mutation M2 kill evidence** (`sub.distance_meters >` mutated to `>=` in `apps/api/src/modules/catalog/catalog.service.ts`):
  ```text
  × src/modules/catalog/catalog.spec.ts > Supply & Catalog modules integration tests (P2-01) > R2: geo cursor pagination over 27 products with limit=10 has no duplicates/gaps, non-decreasing distances, and id ASC tie-breaking 1716ms
    → expected [ …(30) ] to have a length of 27 but got 30
  Test Files  1 failed (1)
       Tests  1 failed | 6 passed (7)
  ```
- Reverted M2 and re-verified full workspace checks: `apps/api` 11 files / `81 passed (81)`.
