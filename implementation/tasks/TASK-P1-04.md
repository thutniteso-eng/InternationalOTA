# TASK P1-04 — Money, FX and time primitives (+ P1-03 carry-overs)

## OBJECTIVE
One correct, tested way to represent and compute money, exchange rates and travel dates, used by every later module (pricing, booking, payment, finance). No floating-point money anywhere.

## BACKGROUND
Read: `docs/ENGINEERING_STANDARDS.md` (Money/Time rules), `docs/SOLUTION_ARCHITECTURE.md` (booking stores original currency + FX snapshot). VND has 0 minor digits, USD 2. Travel services are sold in the supplier's local date (a tour on 2026-12-24 in Asia/Ho_Chi_Minh is that local date regardless of where the customer is).

## SCOPE
### A. `packages/money` (`@internationalota/money`) — pure TypeScript, no I/O
1. `CurrencyCode` + static table of supported currencies with ISO 4217 minor-unit exponent: VND 0, USD 2, EUR 2, GBP 2, AUD 2, SGD 2, THB 2, CNY 2, KRW 0, JPY 0. Unknown code → `UnsupportedCurrencyError`. (Full ISO tables arrive in P1-05.)
2. `Money` = immutable `{ amountMinor: bigint; currency: CurrencyCode }`.
3. Operations: `add`, `subtract` (same currency only → else `CurrencyMismatchError`), `multiplyByInt(qty)`, `negate`, `isZero/isNegative`, `compare`, `sum(list)` (empty list requires explicit currency).
4. `allocate(money, ratios: bigint[])` — split by integer ratios; remainder distributed largest-remainder first, deterministic tie-break by index; **sum of parts always equals input**.
5. `applyRate(money, rate: Decimal, rounding: RoundingMode)` for percentages/commissions/markups, where `Decimal` = `{ numerator: bigint; denominator: bigint }` built by `decimal('0.125')`.
6. Rounding modes (explicit, no default hidden in callers): `HALF_UP`, `HALF_EVEN`, `DOWN`, `UP`. Rounding applies at the target currency's minor unit.
7. `parseMoney('12.34', 'USD')` → 1234n; rejects more decimals than the currency allows, empty, exponent notation, thousands separators, `NaN`. `formatMoneyPlain(money)` → `'12.34'` (locale formatting is NOT in scope).
8. FX: `convert(money, rate: Decimal, to: CurrencyCode, rounding)` returns `{ converted: Money; snapshot: FxSnapshot }` where `FxSnapshot = { base, quote, rate: string /* exact decimal text */, source: string, asOf: string /* ISO-8601 UTC */ }`. Same-currency conversion returns the input unchanged with rate `'1'`.
9. JSON-safe serialization: `toJSON` → `{ amountMinor: '1234', currency: 'USD' }` (string, because JSON has no bigint) and `fromJSON` with validation.

### B. `packages/time` (`@internationalota/time`)
1. Use `@js-temporal/polyfill` (allowed new dependency); isolate it behind this package so we can switch to native Temporal later without touching callers.
2. `LocalDate` (validated `YYYY-MM-DD`), `isValidTimeZone(tz)` (IANA), `nightsBetween(checkIn, checkOut)` (≥ 0, errors if out < in), `startOfLocalDayUtc(date, tz)` → UTC instant, `toLocalDateTime(instantUtc, tz)`, `addDays`.
3. Tests must include a DST zone (`Europe/Berlin` around 2026-03-29 and 2026-10-25) and `Asia/Ho_Chi_Minh`.

### C. Carry-overs from P1-03 review (mandatory)
- **D1** `createDbClient()` must throw if `DATABASE_URL` is unset — no hard-coded fallback credentials (tests and `.env` provide it).
- **D2** `pnpm db:migrate` must work on a fresh clone without a prior manual build (build the db package first inside the script).
- **D3** Remove the broken `./test` export from `packages/db/package.json` (test helpers are imported by relative path inside the package), or make it real — prefer removal.

## OUT OF SCOPE
Database tables for money/FX, fetching live exchange rates, locale-aware currency formatting, UI. No changes to other packages beyond D1–D3.

## TECHNICAL INSTRUCTIONS
- Allowed new dependencies: `@js-temporal/polyfill`, `fast-check` (dev). Nothing else.
- Forbidden inside `packages/money`: `number` for amounts, `parseFloat`, `Number(...)` on amounts, `Math.round`. Add an ESLint `no-restricted-syntax`/`no-restricted-globals` rule scoped to `packages/money/src` enforcing this.
- Errors are typed classes exported from the package.

## ACCEPTANCE CRITERIA
- Property-based tests (fast-check, ≥ 1000 runs each): `allocate` sum invariant; `add` commutative/associative; `parseMoney`∘`formatMoneyPlain` round-trip for every supported currency; `convert` with rate 1 is identity.
- Example tests: VND 100 000 split 3 ways → 33 334 / 33 333 / 33 333; 10% commission of USD 0.05 under each rounding mode; `parseMoney('1.234','USD')` rejected; `parseMoney('1000.5','VND')` rejected; JSON round-trip.
- Time tests above pass, including both DST transitions.
- D1–D3 each proven (command output in report).
- Fresh clone: format:check, lint, lint:boundaries, typecheck, test, build, licenses:check all exit 0; CI green.

## DELIVERABLES
Branch `task/P1-04-money-time`, PR `[P1-04] Money, FX and time primitives`, report `reports/TASK-P1-04-report.md`.
