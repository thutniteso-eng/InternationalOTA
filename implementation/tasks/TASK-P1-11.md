# TASK P1-11 — Internationalisation foundation (vi / en)

## OBJECTIVE
Every user-facing text and every displayed amount/date can be served in Vietnamese and English from day one, with one shared mechanism for API and web, so adding Korean or Chinese later is a data change, not a code change.

## BACKGROUND
Read: `docs/ENGINEERING_STANDARDS.md`, `reference.languages` (P1-05: `vi`, `en` enabled; `ko`, `zh-Hans`, `ja` disabled), `@internationalota/money` (currency exponents), `@internationalota/time` (IANA zones, `LocalDate`), `ProblemDetailsFilter` (P1-07/P1-10). Product content translations (tour names, descriptions) belong to the catalog (P2-01) and are **out of scope** here.

## SCOPE
### A. Package `packages/i18n` (`@internationalota/i18n`) — pure TypeScript
1. Message catalogs as JSON per locale (`messages/vi.json`, `messages/en.json`) using **ICU MessageFormat** (plurals, select, number args) via `intl-messageformat`.
2. `negotiateLocale(acceptLanguageHeader, enabled: string[], fallback)` — RFC 9110 `Accept-Language` with q-values and BCP 47 prefix matching (`vi-VN` → `vi`); invalid header → fallback. Default fallback from env `DEFAULT_LOCALE` (default `vi`).
3. `t(locale, key, values?)` — unknown key throws in dev/test, returns the key and logs a WARN in production.
4. `formatMoney(money, locale)` — `Intl.NumberFormat` with `style: 'currency'` but **fraction digits forced from the money package's exponent** (never Intl's own default); takes `Money` (bigint) and must not convert through `number` for amounts beyond `Number.MAX_SAFE_INTEGER` (format via string/bigint).
5. `formatLocalDate(localDate, locale)`, `formatInstant(instantUtc, locale, timeZone)` built on `@internationalota/time`.
6. **Catalog parity check:** every key in `en.json` exists in `vi.json` and vice versa, with the same ICU arguments; runs as a test in CI.

### B. API
- Middleware resolves the request locale (explicit `?lang=` query > `Accept-Language` > default), validated against the **enabled** languages in `reference.languages` (cached; refresh on app start is enough).
- `ProblemDetailsFilter` localises `title` and `detail` for the errors we own (400 invalid idempotency key, 401, 403, 404, 409 in progress, 413, 422 key reuse, ledger/validation errors exposed via HTTP); `type` and machine-readable fields stay language-independent. Response sets `Content-Language`.
- Log messages stay English (not localised).

### C. Web (`apps/web`)
- Locale-prefixed routes `/vi/...` and `/en/...`; `/` redirects by `Accept-Language` (same negotiation function). `<html lang>` set correctly; `hreflang` alternates and `x-default` in the page head for SEO.
- A minimal language switcher on the placeholder page; the page's text comes from the shared catalogs.
- Library: `next-intl` **or** a thin wrapper over `@internationalota/i18n` — choose one, justify in the report.

## ALLOWED NEW DEPENDENCIES
`intl-messageformat`; optionally `next-intl` (web only). Licences and `pnpm audit --prod --audit-level high` must pass.

## OUT OF SCOPE
Translating product/catalog content, RTL languages, translation management tooling, enabling `ko`/`zh-Hans`/`ja`.

## ACCEPTANCE CRITERIA
1. Negotiation: `vi-VN,vi;q=0.9,en;q=0.8` → `vi`; `en-GB` → `en`; `fr-FR` → default; `en;q=0, vi` → `vi`; malformed header → default; a disabled language (`ko`) → not selected.
2. API: the same 401 / 413 / 422 error returns Vietnamese text with `Accept-Language: vi` and English with `en`; `type` identical; `Content-Language` correct.
3. `formatMoney`: VND has 0 fraction digits, USD 2, KWD 3 in both locales; an amount of `9007199254740993n` minor units formats exactly (no precision loss).
4. `formatInstant` shows the correct local time for `Asia/Ho_Chi_Minh` and across a `Europe/Berlin` DST change.
5. Catalog parity test fails on a deliberately missing key and on a mismatched ICU argument (show output).
6. Web: `/` with `Accept-Language: en` redirects to `/en`; `/vi` renders `lang="vi"` and Vietnamese text; hreflang tags present.
7. Fresh clone + CI green.

## DELIVERABLES
Branch `task/P1-11-i18n`, PR `[P1-11] Internationalisation foundation`, report `reports/TASK-P1-11-report.md`.
