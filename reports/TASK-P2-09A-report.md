# TASK P2-09A Report — Demo 1: Phu Quoc Demo Loader + Customer Browse Web (Read-Only)

Branch: `task/P2-09A-demo-browse`  
Live Staging URL: `https://luis-mas-milk-important.trycloudflare.com` (`/vi`, `/en`) — protected by Caddy Basic Auth (credentials stored locally in `deploy/staging/.env.staging`, never committed).

## 1. Summary of Changes

### A. Demo Data Loader (`pnpm demo:load`)
- **Files added:** `apps/api/src/scripts/demo-loader.ts`, `apps/api/src/scripts/demo-load.ts`, `apps/api/src/scripts/demo-loader.spec.ts`
- Boots a Nest application context (`NestFactory.createApplicationContext(AppModule)`) and creates all entities strictly through module services (`SupplyService`, `CatalogService`, `InventoryService`, `PricingService`) — no raw SQL inserts or updates.
- **Environment & fixture guards:**
  - Refuses execution with exit code `1` when `APP_ENV=production` (`assertDemoEnvAllowed()` via `resolveAppEnv()`).
  - Refuses any catalog JSON whose suppliers do not contain `"(Demo)"` in their name (`validateDemoCatalogJson()`).
- **Transfer handling:** Keeps `airport-transfer-private` (`xe-rieng-dua-don-san-bay-phu-quoc`) in `draft` status with a clear log note explaining that per-vehicle pricing and on-request departures are not modelled yet (no invented pax pricing).
- **Idempotency & rolling window:**
  - Looks up demo suppliers by name and demo products by `vi` slug.
  - Reuses matching translations, latest price lists, and latest cancellation policies unless the catalog JSON changed.
  - Generates departures for **today + 60 days** (61 days inclusive in product time zone `Asia/Ho_Chi_Minh`, cutoff 60 min), reusing existing departures and adding only newly uncovered rolling dates on subsequent runs.
- **Staging & scripts:** Added `demo:load` scripts to root `package.json` and `apps/api/package.json`, copied `implementation/demo-data` into `deploy/staging/Dockerfile.api`, added `API_INTERNAL_URL: 'http://api:4000'` to `web` in `deploy/staging/compose.yml`, added `--with-load` to `scripts/staging-up.sh`, and documented both `--with-load` and manual container execution in `deploy/staging/README.vi.md`.

### B. Read-Only API Extensions (strictly scoped to browse UI requirements)
- Added `fromPrice: PublicFromPriceDto | null` to `PublicCatalogProductSummary` (`GET /catalog/products`) via batched set-based queries `InventoryService.getUpcomingOpenDepartureDatesBatch()` and `PricingSummaryPort.getPublicProductsFromPrices()` so list cards display `"Từ {fromPrice}"` / `"From {fromPrice}"` or `"Giá theo yêu cầu"` without N+1 queries.
- Added `alternateSlugs: Readonly<Record<string, string>>` to `PublicCatalogProductDetail` (`GET /catalog/products/:locale/:slug`) so detail pages link directly to the corresponding localized slug in `SiteHeader` and `hreflang` alternates.
- No write endpoints were changed and no booking/hold/payment endpoints are called anywhere.

### C. Customer Web (`apps/web`) & i18n (`packages/i18n`)
- **Zero new dependencies** (`package.json` diffs show only the `demo:load` script additions).
- **Pages & same-origin read-only proxy:**
  - `apps/web/src/app/[locale]/layout.tsx` renders non-dismissable `DemoBanner` on every page (`DEMO — dữ liệu minh họa, không phải ưu đãi thật` / `DEMO — sample data, not real offers`).
  - `apps/web/src/app/[locale]/page.tsx` (`GET /{locale}`): SSR search (`q`), type filter chips (`All` / `Tour` / `Activity`), CSS gradient kind cover placeholders, duration, `fromPrice`, cursor `"Load more"`, empty and error states.
  - `apps/web/src/app/[locale]/tours/[slug]/page.tsx` (`GET /{locale}/tours/{slug}`): SSR product facts, OpenStreetMap external link, localized policy sentences from rules + weather clause, localized `hreflang` + language switcher using `alternateSlugs`, and 404 via `notFound()`.
  - `apps/web/src/components/TourAvailabilityQuote.tsx` + `QuoteSummaryPanel.tsx`: 14-day availability window (up to day +61 via `"Next 14 days"` / `"Previous 14 days"`), grouped by local date/time in product time zone, `"Only N left"` when ≤ 5 and `"Sold out"` badges, adult/child/infant steppers (min 1 adult, max 50 total), live `/api/catalog/...` quote calculation, friendly localized problem details on errors (e.g. scuba child restriction), `formatMoney` display, and disabled `"Booking coming soon"` / `"Đặt chỗ sắp ra mắt"` button.
  - `apps/web/src/app/api/catalog/[...path]/route.ts`: read-only `GET` forwarder to `${API_INTERNAL_URL}/catalog/...` so `/api/catalog/...` works identically both under Caddy (`/api/*` strip_prefix in staging) and standalone `next dev` / `next start`.
- **i18n & JSX string literal guard:** All UI copy lives in `packages/i18n/messages/{vi,en}.json`; verified by `catalog-parity.spec.ts` and a TypeScript TSX AST check in `apps/web/src/app/browse.spec.tsx`.

---

## 2. Staging Loader Evidence (Real Runs on `ota_staging`)

### Run 1 (`./scripts/staging-up.sh --with-load`)
```text
Loading Phu Quoc demo catalog (--with-load)...
[demo:load] keeping transfer product "xe-rieng-dua-don-san-bay-phu-quoc" as draft (per-vehicle pricing and on-request departures are not modelled yet).
{
  "suppliersCreated": 3,
  "suppliersReused": 0,
  "productsCreated": 9,
  "productsPublished": 8,
  "productsDraftKept": 1,
  "translationsUpserted": 18,
  "priceListsCreated": 8,
  "priceListsReused": 0,
  "policiesCreated": 8,
  "policiesReused": 0,
  "departuresCreated": 610,
  "departuresSkipped": 0,
  "notes": [
    "[demo:load] keeping transfer product \"xe-rieng-dua-don-san-bay-phu-quoc\" as draft (per-vehicle pricing and on-request departures are not modelled yet)."
  ]
}
```

### Run 2 (`docker compose -f deploy/staging/compose.yml exec -T api node apps/api/dist/scripts/demo-load.js`)
```text
[demo:load] keeping transfer product "xe-rieng-dua-don-san-bay-phu-quoc" as draft (per-vehicle pricing and on-request departures are not modelled yet).
{
  "suppliersCreated": 0,
  "suppliersReused": 3,
  "productsCreated": 0,
  "productsPublished": 0,
  "productsDraftKept": 1,
  "translationsUpserted": 0,
  "priceListsCreated": 0,
  "priceListsReused": 8,
  "policiesCreated": 0,
  "policiesReused": 8,
  "departuresCreated": 0,
  "departuresSkipped": 610,
  "notes": [
    "[demo:load] keeping transfer product \"xe-rieng-dua-don-san-bay-phu-quoc\" as draft (per-vehicle pricing and on-request departures are not modelled yet)."
  ]
}
```

### Production Guard Check (`APP_ENV=production`)
```text
$ docker compose -f deploy/staging/compose.yml exec -T -e APP_ENV=production api node apps/api/dist/scripts/demo-load.js
demo:load failed: Refusing to run demo:load in production (APP_ENV=production).
EXIT_CODE:1
```

---

## 3. Live Tunnel Verification & Mobile Screenshots (390×844)

### Tunnel SSR & Search / 404 Checks (`https://luis-mas-milk-important.trycloudflare.com`)
```text
GET /api/health/ready -> HTTP 200
GET /vi -> HTTP 200
GET /en -> HTTP 200
GET /vi?q=hon%20thom -> HTTP 200
Tour cano 4 đảo kết hợp cáp treo Hòn Thơm
GET /vi/tours/tour-cano-4-dao-nam-phu-quoc -> HTTP 200
south-phu-quoc-4-island-speedboat-tour
GET /en/tours/south-phu-quoc-4-island-speedboat-tour -> HTTP 200
GET /vi/tours/does-not-exist-xyz -> HTTP 404
```

### Screenshots at 390px Width

| List (`vi`) | Detail (`vi`) | Quote `2/1/1` = `2.550.000 ₫` (`vi`) | List (`en`) |
|---|---|---|---|
| ![List vi 390px](screenshots/p2-09a/list-vi.png) | ![Detail vi 390px](screenshots/p2-09a/detail-vi.png) | ![Quote vi 390px](screenshots/p2-09a/quote-vi.png) | ![List en 390px](screenshots/p2-09a/list-en.png) |

---

## 4. Accessibility Smoke Verification
- Headings follow a strict hierarchy (`h1` page title → `h2` section/card titles → `h3` departure date group headings).
- Decorative CSS kind gradient cover placeholders carry `aria-hidden="true"`.
- Form search input (`#catalog-search-input`) has a `<label htmlFor="catalog-search-input">` and steppers use native `<button type="button">` controls with localized `aria-label` attributes (`Giảm/Tăng số lượng ...` / `Decrease/Increase ...`) supporting keyboard `Tab` + `Enter`/`Space`.
- Tap targets (`button`, `.chip`, `.langLink`, `.stepperBtn`, `.backLink`, `.mapLink`) enforce `min-height: 44px; min-width: 44px`, and text colors (`#0f172a`, `#475569`, `#0b5b6b` / `#ffffff`) maintain WCAG AA contrast with zero horizontal overflow at `390px` viewport width.

---

## 5. Automated Checks & Workspace Verification
- `pnpm format:check`: passed
- `pnpm lint`: passed (including `apps/api` and `apps/web` TypeScript ESLint rules)
- `pnpm lint:boundaries`: `✔ no dependency violations found (125 modules, 490 dependencies cruised)`
- `pnpm typecheck`: passed (`next typegen && tsc --noEmit` + all workspace packages/API)
- `pnpm build`: passed (including `next build` for `apps/web`: `/`, `/_not-found`, `/[locale]`, `/[locale]/tours/[slug]`, `/api/catalog/[...path]`)
- `pnpm test` (`DATABASE_URL=postgresql://ota_user:ota_password@localhost:55432/ota_dev`):
  - `@internationalota/api`: `14` test files / `105` tests passed (including `src/scripts/demo-loader.spec.ts` covering AC1/AC2/AC4/production subprocess exit `1`)
  - `@internationalota/web`: `2` test files / `8` tests passed (including `src/app/browse.spec.tsx` covering AC2 `2.550.000 ₫` / `₫2,550,000`, AC3/AC4 SSR HTML & 404, AC5 TSX AST zero-hardcoded-literal guard, helpers)
  - Workspace packages (`money`, `shared`, `time`, `db`, `i18n`) + `tools`: all passed (`16` tests in `tools`, `21` in `i18n`, `41` in `money`, `22` in `time`, `19` in `db`, `2` in `shared`)
- `pnpm licenses:check`: `All 471 package licenses verified successfully`
- `pnpm audit --prod --audit-level high`: passed (exit 0)
- Dependency diff (`git diff -- "package.json" "apps/*/package.json" "packages/*/package.json"`): no added dependencies (only `demo:load` scripts).
