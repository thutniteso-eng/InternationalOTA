# TASK P2-09A — Demo 1: load Phu Quoc demo data + customer browse web (read-only)

## OBJECTIVE
The Owner can open the staging link on a phone and **browse real-looking Phu Quoc tours** in Vietnamese and English:
- a list with search and type filter;
- a tour detail page;
- available departures with remaining seats;
- a live price quote for N adults/children/infants.

There is no booking yet; the "Book" button shows "coming soon". This task is pulled forward from P2-09 by **D-021**.

## BACKGROUND
Read:
- D-021, D-020;
- P2-01 (catalog public API), P2-02 (availability), P2-03 (quote, `fromPrice`, `cancellationSummary`);
- P1-11 i18n (`t`, `formatMoney`, `formatLocalDate`);
- `implementation/demo-data/phu-quoc-demo-catalog.json`;
- `deploy/staging/` (Caddy routes `/api/*` → api; everything else → web; staging is behind basic auth).

Web stack: Next.js 16 App Router in `apps/web`, existing `[locale]` routing.

## SCOPE
### A. Demo data loader `pnpm demo:load` (in `apps/api`, CLI using a Nest application context)
- It must create everything **through the module services** (supply, catalog, inventory, pricing), never raw SQL, so all validations and triggers apply.
- **Steps:**
  - create the 3 demo suppliers (active) and the 9 products with vi/en translations;
  - publish them;
  - price list v1 from `pricing` (`ageBands` "10+", "5-9", "0-4" → `min_age`/`max_age`; `infant.occupies_seat = false`; scuba adult-only 12+);
  - cancellation policy v1 from `cancellationPolicy.rules` (+ weather clause text);
  - departures for **today + 60 days** (product time zone) from `departureTimes`/`operatingDays`/`capacityPerDeparture`, default cutoff 60 min.
- **Transfers:** the transfer product is catalog + price only (per-vehicle pricing is not modelled yet). Load it as a **draft** with a log line explaining why, or skip it. Do not invent a pax price.
- **Idempotent:**
  - each demo entity is found by a stable key: the product slug (vi), and the supplier name;
  - re-running creates nothing new except departures for newly uncovered days (rolling window);
  - existing price list/policy versions are reused when identical, and a new version is created only if the JSON changed.
- **Environment guard:** `APP_ENV` ∈ {local, test, staging} only; `production` → exit 1 with a clear message. Suppliers must contain "(Demo)" in the name; the loader refuses JSON whose supplier names lack it.
- The old `[FAKE]` fixtures (`pnpm catalog:fixtures`) stay local/test-only and unchanged.
- **Staging:** document the command in `deploy/staging/README` (run inside the api container after `staging-up.sh`). Optional flag `--with-load` on `staging-up.sh`.

### B. Customer web (apps/web) — read-only, mobile-first
- Data is fetched **server-side** from the API using env `API_INTERNAL_URL` (compose: `http://api:4000`; local dev: `http://localhost:4000`). The browser calls the API only via same-origin `/api/...` for the quote form.
- **Pages (both `vi` and `en`, `hreflang` alternates, `<title>`/meta description from content):**
  1. **`/{locale}` — Home/list:**
     - search box (accent-insensitive via the API `q`) and type filter chips (Tour / Activity);
     - cards showing title, summary (2 lines), duration, "From {fromPrice}" or "Price on request", and a type badge;
     - cursor pagination ("Load more");
     - empty and error states.
  2. **`/{locale}/tours/{slug}` — Detail:**
     - title, summary, description, highlights, inclusions/exclusions, meeting point, duration;
     - an "Open map" link to OpenStreetMap at the coordinates (an external link only, no map library);
     - a cancellation policy rendered as readable sentences from rules (e.g. "Free cancellation up to 48 hours before start; 50% refund up to 24 hours");
     - the other locale's slug is used for the language switch.
  3. **Availability on the detail page:**
     - next 14 days (up to 62 via "Next" navigation), grouped by local date;
     - each departure shows local time and remaining seats ("12 seats left" / "Sold out"; "Only N left" when ≤ 5);
     - dates and times are formatted for the locale in the **product time zone**.
  4. **Quote widget:**
     - choose a departure, then adult/child/infant steppers (min 1 adult, max 50 total);
     - calls the public quote endpoint and shows line items and total formatted via `formatMoney`;
     - shows the API's typed errors as friendly localized messages;
     - a "Book" button that is disabled, labelled "Booking coming soon".
- **Every page** shows a thin, non-dismissable banner: "DEMO — dữ liệu minh họa, không phải ưu đãi thật" / "DEMO — sample data, not real offers".
- **Visuals:**
  - clean, accessible, mobile-first CSS (CSS Modules or plain CSS); **no new runtime dependencies** (no UI kit, no map lib, no image CDN);
  - no third-party photos: use a tasteful CSS placeholder per product kind (gradient + kind label);
  - text contrast WCAG AA; tap targets ≥ 44px; works at 360px width.
- **Strings:** all UI strings in `packages/i18n` messages (vi/en), none hard-coded. Money and dates only via `@internationalota/i18n`.
- **API:** no changes beyond strictly necessary read-only additions; if any are needed, list them in the report. Booking/hold/payment endpoints must not be called.

## OUT OF SCOPE
Booking, holds, login UI, payment, admin UI, images/media upload, maps, SEO sitemap, analytics, PWA.

## ACCEPTANCE CRITERIA
1. **Loader:** on a fresh DB, `pnpm demo:load` creates 3 suppliers, 8 published products (transfer handled as specified), a price list and policy for each, and departures for 61 days. A second run creates 0 products, 0 versions and 0 duplicate departures (show counts). With `APP_ENV=production` it exits 1. The integration test runs on an isolated temp DB.
2. **Arithmetic shown in the UI equals the API:** a test renders the quote for "Tour cano 4 đảo" with 2 adults, 1 child and 1 infant and asserts the total `2.550.000 ₫` (vi) and `₫2,550,000` (en).
3. **Pages:**
   - `next build` succeeds;
   - server-rendered HTML of `/vi`, `/en`, one detail page per locale, and an unknown slug (404) is verified by tests (Vitest against the server components or `next start` + fetch in a test script);
   - every page contains the DEMO banner;
   - search for `hon thom` (no accents) finds the cable car tour.
4. **Availability correctness:** for a departure with capacity 40 and 3 seats allocated via the inventory API in the test, the page shows "37" remaining. Closed and cutoff-passed departures are not shown.
5. **i18n:** there are no untranslated keys. A lint/test fails if a UI string literal is hard-coded in JSX (simple custom check is fine). The language switch keeps the user on the same tour via the other locale's slug.
6. **Accessibility smoke:** headings are in order, images/placeholders have alt or `aria-hidden`, form controls have labels, and the steppers are keyboard operable (documented manual check plus a test where feasible).
7. **Staging:**
   - after `staging-up.sh` and `demo:load`, the Owner can open `https://<tunnel>/vi` on a phone (behind basic auth) and browse;
   - the report includes 4 screenshots at 390px width (list vi, detail vi, quote result vi, list en) and the tunnel URL.
8. **Hygiene:** no new dependencies (`git diff` of package.json files shows none, or each is justified and approved first). Fresh clone + CI green. `lint:boundaries` green.

## DELIVERABLES
Branch `task/P2-09A-demo-browse`, PR `[P2-09A] Demo browse web + demo loader`, report `reports/TASK-P2-09A-report.md` with screenshots, loader output (both runs), test output and `git ls-remote` proof.
