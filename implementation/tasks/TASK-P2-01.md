# TASK P2-01 — Catalog: suppliers, tours & activities (vi/en)

## OBJECTIVE
Staff can create tours/activities for Phu Quoc suppliers in Vietnamese and English and publish them; customers can browse and search **only** published products, by language, type, text and location. This is the first business module of Phase 2.

## BACKGROUND
Phase 2 approved by Owner 2026-11-26. Read: `docs/SOLUTION_ARCHITECTURE.md` (modules `supply`, `catalog`), `docs/ENGINEERING_STANDARDS.md`, P1-06 roles (`admin`, `operator`, `customer`), P1-07 `@Idempotent()`, P1-11 i18n (`i18nKey` errors, enabled languages in `reference.languages`). Inventory (P2-02), prices (P2-03) and media upload are separate tasks. PostGIS is available (postgis image since P1-01).

## SCOPE
### A. Schemas (new migration; extensions `unaccent` and `pg_trgm` created by the migration)
- `supply.suppliers`: `id` (v7), `name`, `legal_name NULL`, `country_alpha2` FK reference.countries, `contact_email NULL`, `contact_phone NULL`, `status` CHECK IN (`active`,`suspended`), timestamps.
- `catalog.products`: `id`, `supplier_id` FK, `kind` CHECK IN (`tour`,`activity`,`transfer`), `status` CHECK IN (`draft`,`published`,`archived`), `country_alpha2`, `region text` (e.g. "Phú Quốc"), `location geography(Point,4326) NULL`, `meeting_point_note NULL`, `time_zone` (must be valid IANA, default `Asia/Ho_Chi_Minh`), `duration_minutes int NULL CHECK > 0`, `published_at NULL`, timestamps.
- `catalog.product_translations`: `product_id` FK, `locale` FK → `reference.languages(tag)`, `title`, `slug`, `summary`, `description`, `highlights jsonb` (array of strings), `inclusions jsonb`, `exclusions jsonb`; PK `(product_id, locale)`; `UNIQUE (locale, slug)`; slug format `^[a-z0-9]+(-[a-z0-9]+)*$`.
- `catalog.product_images`: `product_id`, `url` (https only), `sort smallint`, `alt jsonb` (`{ "vi": "...", "en": "..." }`); max 20 per product. (Hosting/upload of images is out of scope.)
- Grants for `ota_app` added via the existing runtime-grants mechanism (P1-12).

### B. Module boundaries
`apps/api/src/modules/supply/` and `apps/api/src/modules/catalog/`, each with `index.ts`; catalog may use supply only through its public API. `lint:boundaries` stays green.

### C. Admin API (roles `admin` or `operator`; all mutating endpoints `@Idempotent()`)
- Suppliers: create, update, suspend/reactivate, list.
- Products: create (draft), update fields, upsert a translation, set images, **publish**, **archive**, list (any status, filters).
- **Publish rule:** allowed only if (1) the supplier is `active`, (2) a translation exists for **every enabled language** (today vi + en) with non-empty title/summary/description, (3) `location` and `time_zone` are set. Otherwise 422 with an `i18nKey` naming the missing items.
- Suspending a supplier hides all its products from public endpoints without changing their status.

### D. Public API (no auth)
- `GET /catalog/products?locale=&kind=&q=&near=lat,lng&radiusKm=&cursor=&limit=` → published products of active suppliers, translated to the resolved locale (P1-11 negotiation when `locale` is absent). Cursor pagination (opaque, stable ordering), `limit` ≤ 50.
- `q`: accent-insensitive search on title + summary of the resolved locale (`unaccent` + `pg_trgm`), so `dao ngoc` finds "Đảo Ngọc".
- `near` + `radiusKm` (≤ 200): PostGIS `ST_DWithin`, results include distance in metres.
- `GET /catalog/products/:locale/:slug` → one product; 404 for draft/archived/suspended-supplier products (no information leak about their existence).
- Responses never expose supplier contact data or internal fields.

### E. Dev fixtures
`pnpm catalog:fixtures` creates 1 supplier + 3 products clearly marked `[FAKE]` in the title; refuses to run when `APP_ENV` is `staging` or `production`. Real Phu Quoc data will be entered by staff through the admin API.

## OUT OF SCOPE
Prices/rates (P2-03), availability/capacity (P2-02), image upload/storage, reviews, SEO pages in the web app, supplier self-service portal.

## ACCEPTANCE CRITERIA (integration tests, isolated temporary database)
1. Publish blocked (422, correct `i18nKey`) when: supplier suspended / `en` translation missing / location missing; succeeds when all present.
2. Public list/detail never return draft, archived, or suspended-supplier products (also not via direct slug).
3. Same product returns Vietnamese text with `locale=vi` and English with `locale=en`; slug lookup is per locale.
4. Search: `q=dao ngoc` and `q=đảo ngọc` both find a product titled "Tour Đảo Ngọc"; a product with the word only in the other locale is not matched.
5. Geo: two products 3 km and 40 km from a point → `radiusKm=10` returns only the first, with correct distance (±1%).
6. Cursor pagination over 120 products: no duplicates, no gaps, stable under concurrent inserts of new products.
7. Customer → admin endpoints 403; anonymous → 401; idempotent replay of a create returns the same product.
8. Supplier contact fields never appear in public responses (assert on raw JSON).
9. `lint:boundaries` fails on a deliberate import of supply internals from catalog (show output).
10. Fresh clone + CI green; staging-migrate grants work (run `scripts/staging-up.sh` and show a public list call through the tunnel returning `[]` or fixtures in local only).

## DELIVERABLES
Branch `task/P2-01-catalog`, PR `[P2-01] Catalog`, report `reports/TASK-P2-01-report.md`.
