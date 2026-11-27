# TASK P2-09 — Customer booking web (Demo 2): sign-in, hold, pay (Mock), status, my bookings, cancel

## OBJECTIVE
On a phone, through the staging link, the Owner can:
- create an account and verify the email (Mailpit);
- pick a tour departure and passengers, then place a hold at the quoted price;
- pay through the Mock gateway;
- land on a status page that turns **Confirmed** only after the server confirms;
- see "My bookings";
- cancel with a clear refund preview, then watch the refund complete.

This is **Demo 2**. It also lands polish items **U2–U4** from P2-09A.

## BACKGROUND
Read:
- P2-09A web (routes, `catalog-api.ts`, `TourAvailabilityQuote.tsx`, DEMO banner, i18n rules, no new deps);
- identity (better-auth at `/api/auth/*`, D-018);
- P2-04 booking API (`POST /bookings` with `expectedSnapshotHash`, typed 409/422 outcomes, `GET /bookings/:reference`, `GET /me/bookings`, cancel);
- P2-05 `POST /bookings/:reference/checkout` → `redirectUrl`, and `payment: {status, attemptCount}` on the booking detail;
- P2-07 confirmed-cancel response (`refundAmountMinor`, `refundPercent`, `ruleApplied`) and `refund` on the detail;
- P2-08 emails and the shared policy-sentence formatter (U1);
- P1-07 `Idempotency-Key`;
- `deploy/staging/Caddyfile` (`/api/*` → api; same origin, so the cookies work).

## SCOPE
### A. Minimal API addition (read-only)
- `GET /bookings/:reference/cancellation-preview` (owner only), evaluated at DB `now()`. It returns:
  - for **confirmed**: `{ refundAmountMinor, refundPercent, ruleApplied, cancellable }`;
  - for **held/payment_pending**: `{ refundAmountMinor: 0, cancellable: true, reason: 'not_paid' }`.
- No other API changes, unless strictly necessary; list any in the report.

### B. Web (apps/web, Next.js App Router; **no new dependencies**)
- **Local dev:** add Next `rewrites` for `/api/:path*` → `API_INTERNAL_URL` (all methods, cookies forwarded) and remove the GET-only catalog proxy route. Staging continues via Caddy.
- **Auth pages** `/{locale}/sign-up`, `/{locale}/sign-in` and sign-out:
  - email + password + display name, using better-auth's REST endpoints with plain `fetch`;
  - a `returnTo` parameter, restricted to same-origin paths;
  - a header showing the signed-in name and a "My bookings" link;
  - a "Please verify your email" banner with a **Resend** button (rate-limited by the API) while unverified.
- **Booking flow from the tour detail page:**
  1. **Pick and quote (U3):** a compact **date strip** (14 days, horizontally scrollable; disabled "previous" on the first window, U4) and a time selection.
     - Pax steppers show the age bands next to each label (U2), e.g. "Trẻ em (5–9 tuổi)", taken from the quote/price list.
     - A live quote is shown, then the primary button "Đặt tour" / "Book now".
  2. If not signed in, go to sign-in with `returnTo`. On return, restore the selection.
  3. **Contact step** (`/{locale}/book/{departureId}?adult=&child=&infant=`): name, email (prefilled from the account), phone (E.164 hint, light validation), plus a summary card.
     - Submit calls `POST /bookings` with a fresh `Idempotency-Key` per submit attempt; a network retry reuses the same key.
     - **Typed outcomes:**
       - `price_changed` → show the old vs new total and require an explicit "Accept new price" (re-submit with the new hash);
       - `sold_out` / `closed` / `cutoff_passed` → a friendly message and back to the date strip;
       - `too_many_active_holds` → a link to My bookings.
  4. **Booking page** `/{locale}/bookings/{reference}`:
     - status badge, a hold **countdown** (server time from `holdExpiresAt`, refreshed from the server on focus), summary, price lines and the policy sentences (U1 formatter);
     - "Thanh toán" / "Pay now" → `POST …/checkout` → `window.location = redirectUrl`;
     - unverified email → banner and the pay button disabled.
  5. **Return page** `/{locale}/bookings/{reference}/return`:
     - **never trusts query params**; it polls `GET /bookings/:reference` every 2 s for up to 60 s;
     - shows Confirmed / Payment failed (retry allowed while the hold is valid) / Still processing (with "we'll email you").
  6. **My bookings** `/{locale}/me/bookings`: a cursor list with status chips.
  7. **Cancel:** the button opens an in-page confirm panel (**no `window.confirm`/`alert`**) with the preview: "Bạn sẽ được hoàn 500.000 ₫ (50%)". Confirming calls cancel (Idempotency-Key) and shows the result, then the refund status, which updates on reload.
- **All pages:** DEMO banner, vi/en with the locale switch kept on the same page, strings only in `packages/i18n`, money and dates only via P1-11, mobile-first at 360px, tap targets ≥ 44px, labelled form controls, visible focus, and `aria-live` for countdown and status changes.
- Nothing sensitive in `localStorage`. At most the last pax selection (try/catch).

## OUT OF SCOPE
Social login, password reset UI (the email exists from P2-08; a page is optional and only if trivial), admin UI, real payment, invoices, reviews, images/maps, SEO beyond existing metadata.

## ACCEPTANCE CRITERIA
1. **E2E script** `scripts/e2e-demo2.mjs` (Node, `fetch` only, run against a running local or staging stack). Over HTTP it performs:
   - sign-up, verify via the Mailpit API (`/api/v1/messages`), sign-in;
   - quote, hold, checkout, follow the Mock page "Pay successfully" form;
   - poll until `confirmed`, assert the 2 emails in Mailpit;
   - cancellation preview, cancel at more than 48h → refund 100% → poll the refund until `succeeded`.

   Exit 0 with a summary. The report includes its output against staging.
2. **Component/unit tests (Vitest):**
   - the steppers enforce ≥ 1 adult and ≤ 50 total, and show the age bands;
   - the date strip disables "previous" on the first window;
   - the `price_changed` dialog requires explicit acceptance;
   - the return page shows Confirmed only when the API status is `confirmed` (mock the fetch);
   - `returnTo` rejects external URLs;
   - the cancel panel shows the preview amount formatted vi/en.
3. **No trust in the client:** tampering with the total in the browser has no effect (the server re-quotes). The return page with `?status=success` but an API status of `payment_pending` shows "processing".
4. **Accessibility smoke:** headings in order, labels, focus order, `aria-live` regions (documented manual check plus tests where feasible).
5. **Screenshots at 390px** in the report: date strip with age bands (vi), price_changed dialog (en), booking page with countdown (vi), Mock payment page, Confirmed status (vi), My bookings (en), cancel preview (vi), Mailpit confirmed email (vi).
6. **Hygiene:** no new dependencies; the old catalog proxy route is removed; fresh clone + CI green; `lint:boundaries` green.

## DELIVERABLES
Branch `task/P2-09-booking-web`, PR `[P2-09] Booking web (Demo 2)`, report `reports/TASK-P2-09-report.md` with the screenshots, the e2e output against staging, test output, the tunnel URL and `git ls-remote` proof.
