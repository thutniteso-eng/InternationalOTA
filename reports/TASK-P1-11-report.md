# TASK P1-11 Report — Internationalisation foundation (vi / en)

## Summary

Implemented the shared internationalisation foundation across `packages/i18n`, `apps/api`, and `apps/web` so all user-facing messages, currency amounts, and dates are served in Vietnamese (`vi`) and English (`en`) from a single source of truth, making future locale additions (`ko`, `zh-Hans`, `ja`) a pure data change.

### Key Deliverables

1. **Package `packages/i18n` (`@internationalota/i18n`)**
   - `messages/vi.json` & `messages/en.json`: ICU MessageFormat catalogs covering web UI copy and all platform-owned HTTP Problem Details errors (`400`, `401`, `403`, `404`, `409`, `413`, `422`, `429`, `500`, `502`, `503`, `504`, plus Ledger errors).
   - `negotiateLocale(acceptLanguageHeader, enabled, fallback)` (`src/negotiate.ts`): RFC 9110 `Accept-Language` parser with strict q-value parsing (`q=0` exclusion), BCP 47 prefix fallback (`vi-VN` → `vi`, `en-GB` → `en`), enabled-language validation, and `DEFAULT_LOCALE` env fallback (default `vi`).
   - `t(locale, key, values?)` (`src/translate.ts`): compiles and caches `IntlMessageFormat` instances; throws `MissingTranslationKeyError` on unknown keys in dev/test; logs a structured WARN (via `setI18nWarnLogger` or stderr) and returns the key in production.
   - `formatMoney(money, locale)` (`src/format-money.ts`): uses `Intl.NumberFormat` with `style: 'currency'` and forces `minimumFractionDigits` / `maximumFractionDigits` from `@internationalota/money`'s `getCurrencyExponent` (plus ISO 4217 3-decimal display exponents for non-sale currencies like `KWD`), formatting via exact decimal string from `bigint` arithmetic (`Intl.NumberFormat.prototype.format(string)`). Never converts amounts through JavaScript `Number` (also enforced by ESLint `no-restricted-syntax` in `eslint.config.mjs`).
   - `formatLocalDate(localDate, locale)` and `formatInstant(instantUtc, locale, timeZone)` (`src/format-date.ts`): built on `@internationalota/time` (`parseLocalDate`, `assertValidTimeZone`, `toLocalDateTime`), timezone-safe for `LocalDate` and DST-aware for UTC instants.
   - `validateCatalogParity(catalogs)` (`src/parity.ts`) + `test/catalog-parity.spec.ts`: parses every message's ICU AST via `IntlMessageFormat.prototype.getAst()` and verifies identical keys and identical ICU argument sets across all locales in CI.

2. **API (`apps/api`)**
   - `LocaleService` (`src/common/i18n/locale.service.ts`): queries and caches enabled languages from `reference.languages` (`WHERE enabled = true`) on module startup (`onModuleInit`), resolving requests in precedence `?lang=` query > `Accept-Language` > `DEFAULT_LOCALE`.
   - Middleware in `src/app.setup.ts`: resolves locale per request, stores it on `req.locale` and in `AsyncLocalStorage` (`request-context.ts`), sets `Content-Language`, wires `setI18nWarnLogger` to Pino, and localizes 413 `sendPayloadTooLarge` responses.
   - `ProblemDetailsFilter` (`src/common/http/problem-details.filter.ts`): localizes `title` and `detail` for platform-owned HTTP and `LedgerError` responses while keeping `type`, `status`, and machine-readable fields language-independent and keeping server-side logs in English.

3. **Web (`apps/web`) — Thin wrapper over `@internationalota/i18n` (vs `next-intl`)**
   - **Library choice & justification:** Chose a **thin wrapper over `@internationalota/i18n`** (`apps/web/src/i18n/config.ts`) rather than adding `next-intl`:
     1. **Single shared mechanism:** `apps/web` calls the exact same `negotiateLocale`, `t`, `formatMoney`, and `formatLocalDate` functions and the exact same JSON catalogs as `apps/api`, avoiding duplicate config or diverging `Accept-Language` negotiation rules.
     2. **Minimal dependency & upgrade surface:** Zero additional third-party web runtime dependencies, eliminating Next.js 16 / React 19 peer-dependency churn and keeping the license/audit surface minimal.
     3. **Data-only locale expansion:** Enabling `ko` or `zh-Hans` later only requires adding a JSON catalog and listing the locale in `BUILTIN_LOCALES`.
   - Routes:
     - `apps/web/src/app/(root)/page.tsx`: redirects `/` using `Accept-Language` via `resolveWebLocale` (`negotiateLocale`) with HTTP `307`.
     - `apps/web/src/app/[locale]/layout.tsx`: sets `<html lang={locale}>`, generates static params for `vi`/`en`, and emits canonical + `hreflang` alternates (`vi`, `en`, `x-default`) via `generateMetadata`.
     - `apps/web/src/app/[locale]/page.tsx`: renders localized copy, sample `formatMoney`, sample `formatLocalDate`, and a minimal language switcher (`<nav>` with `<Link href="/vi">` and `<Link href="/en">`).

## Dependencies & Security

- Added only `intl-messageformat` pinned to `12.2.1` (`BSD-3-Clause`) in `packages/i18n/package.json`.
- `pnpm licenses:check`: passed (`✅ All 471 package licenses verified successfully.`).
- `pnpm audit --prod --audit-level high`: passed (0 high/critical vulnerabilities).

## Acceptance Criteria Evidence

### AC1 — Locale Negotiation

Verified in `packages/i18n/test/i18n.spec.ts` (18 tests passing):

- `vi-VN,vi;q=0.9,en;q=0.8` → `vi`
- `en-GB` → `en`
- `fr-FR` → `vi` (default)
- `en;q=0, vi` → `vi`
- Malformed headers (`;;;not-valid;;;`, `en;q=9.9`, `12345`) → `vi` (default)
- Disabled language (`ko`) → not selected (falls back to `vi` or next enabled candidate)

### AC2 — API Localized Problem Details

Verified in `apps/api/src/common/i18n/i18n.spec.ts` (5 integration tests passing against an isolated temporary PostgreSQL database seeded with `reference.languages`):

- `401` (`/__test/i18n/protected`), `413` (`/webhooks/test` > 1 MiB), and `422` (idempotency key reuse on `/__test/i18n/idempotent`) return Vietnamese with `Accept-Language: vi` (`Content-Language: vi`) and English with `Accept-Language: en` (`Content-Language: en`), with identical `type` URLs.
- `?lang=en` overrides `Accept-Language: vi`; disabled `?lang=ko` / `Accept-Language: ko-KR,ko;q=0.9` is rejected and falls back to `vi`.
- 5xx server-side logs remain in English (`http_server_error`, `Unexpected database timeout`).

### AC3 — `formatMoney` Exponents & BigInt Precision

Verified in `packages/i18n/test/i18n.spec.ts`:

- `VND`: 0 fraction digits in both `en` and `vi`
- `USD`: 2 fraction digits in both `en` and `vi`
- `KWD`: 3 fraction digits in both `en` and `vi`
- `9007199254740993n` formats exactly without precision loss:
  - `en VND`: `₫9,007,199,254,740,993` | `vi VND`: `9.007.199.254.740.993 ₫`
  - `en USD`: `$90,071,992,547,409.93` | `vi USD`: `90.071.992.547.409,93 US$`
  - `en KWD`: `KWD 9,007,199,254,740.993` | `vi KWD`: `9.007.199.254.740,993 KWD`

### AC4 — `formatInstant` & `formatLocalDate`

Verified in `packages/i18n/test/i18n.spec.ts`:

- `2026-06-15T10:30:00Z` in `Asia/Ho_Chi_Minh` → `17:30:00`
- `Europe/Berlin` spring-forward (`2026-03-29T00:30:00Z` → `01:30:00` CET; `2026-03-29T01:30:00Z` → `03:30:00` CEST)
- `Europe/Berlin` autumn fallback (`2026-10-25T00:30:00Z` → `02:30:00` CEST; `2026-10-25T01:30:00Z` → `02:30:00` CET)

### AC5 — Catalog Parity Failure Output

Deliberately deleted `home.sampleDateLabel` from `packages/i18n/messages/vi.json` and changed `{name}` to `{wrongArg}` in `common.greeting`, then ran `pnpm --filter @internationalota/i18n exec vitest run test/catalog-parity.spec.ts`:

```text
 FAIL  test/catalog-parity.spec.ts > AC5: Message catalog parity > verifies vi.json and en.json have identical keys and identical ICU arguments
AssertionError: expected [ …(2) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "ICU argument mismatch for key \"common.greeting\": en=[name] vs vi=[wrongArg]",
+   "Missing key \"home.sampleDateLabel\" in locale \"vi\" (present in: en)",
+ ]

 ❯ test/catalog-parity.spec.ts:7:27
```

After restoring `vi.json`, `test/catalog-parity.spec.ts` passed (`3 passed (3)`).

### AC6 — Web Routing, `<html lang>`, and `hreflang`

Verified both in unit tests (`apps/web/src/app/page.spec.ts`, 4 tests passing) and live against `next start`:

```text
=== GET / with Accept-Language: en ===
HTTP/1.1 307 Temporary Redirect
location: /en

=== GET /vi ===
<html lang="vi">
<link rel="alternate" hrefLang="vi" href="/vi"/>
<link rel="alternate" hrefLang="en" href="/en"/>
<link rel="alternate" hrefLang="x-default" href="/vi"/>
Nền tảng du lịch độc lập hiện đại

=== GET /en ===
<html lang="en">
<link rel="alternate" hrefLang="vi" href="/vi"/>
<link rel="alternate" hrefLang="en" href="/en"/>
<link rel="alternate" hrefLang="x-default" href="/vi"/>
Modern Independent Travel Platform
```
