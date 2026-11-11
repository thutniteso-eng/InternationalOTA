# TASK P1-04 report

## Implemented

### A. `@internationalota/money` (`packages/money/`) — Pure TypeScript, No I/O, No Floats
- **Static Currency Table & Exponents (`packages/money/src/currencies.ts`)**:
  - `CurrencyCode` union covering all 10 supported currencies with ISO 4217 minor-unit exponent:
    - VND: 0
    - USD, EUR, GBP, AUD, SGD, THB, CNY: 2
    - KRW: 0
    - JPY: 0
  - `getCurrencyExponent` and `assertSupportedCurrency` throw `UnsupportedCurrencyError` for unknown codes.
- **Immutable Money Value Object (`packages/money/src/money.ts`)**:
  - `Money` = `{ readonly amountMinor: bigint; readonly currency: CurrencyCode }` (frozen via `Object.freeze`).
  - Arithmetic operations:
    - `add(a, b)`: checks matching currency, returns new `Money` (or throws `CurrencyMismatchError`).
    - `subtract(a, b)`: checks matching currency, returns new `Money` (or throws `CurrencyMismatchError`).
    - `multiplyByInt(m, qty)`: integer scalar multiplication (`amountMinor * qty`).
    - `negate(m)`: returns `-amountMinor`.
    - `isZero(m)` and `isNegative(m)`.
    - `compare(a, b)`: returns `-1 | 0 | 1` (or throws `CurrencyMismatchError`).
    - `sum(list, currency?)`: computes sum; if list is empty, requires explicit `currency` parameter (or throws `EmptyListError`), returning `0n` in that currency.
- **Allocation by Integer Ratios (`packages/money/src/allocate.ts`)**:
  - `allocate(money, ratios: bigint[])`: splits total `amountMinor` by integer ratios using integer division.
  - Leftover units are distributed largest-remainder first with deterministic tie-breaking by ratio index.
  - Sum of allocated parts strictly equals input `amountMinor` in all cases (including negative amounts).
- **Exact Decimal Representation (`packages/money/src/decimal.ts`)**:
  - `Decimal` = `{ readonly numerator: bigint; readonly denominator: bigint; readonly text: string }`.
  - `decimal(str: string)` parses strings (e.g. `'0.125'`, `'10'`, `'-0.5'`) into reduced coprime fractions using bigint GCD without floating-point math. Rejects scientific notation, commas, NaN, or non-numeric tokens.
- **Explicit Rounding Modes (`packages/money/src/rounding.ts` & `rate.ts`)**:
  - `RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP'`.
  - `applyRate(money, rate: Decimal, rounding: RoundingMode)`: applies decimal rate and rounds exact integer fraction at the currency's minor unit.
  - `HALF_EVEN` implements banker's rounding (rounds to nearest even on equidistant 0.5 ties).
- **Format and Parse (`packages/money/src/format.ts`)**:
  - `parseMoney(str, currency)`: parses decimal strings into `bigint` minor units (e.g. `parseMoney('12.34', 'USD')` -> `1234n`). Rejects inputs exceeding the currency exponent, empty strings, exponential notation, thousands separators/commas, and NaN.
  - `formatMoneyPlain(money)`: plain string formatting (e.g. `'12.34'`, `'100000'`, `'-0.50'`) without locale styling.
- **FX Conversion (`packages/money/src/fx.ts`)**:
  - `convert(money, rate: Decimal, to: CurrencyCode, rounding, options?)` converts between currencies taking base and quote exponents into account:
    $$\text{convertedMinor} = \text{round}\left(\frac{\text{amountMinor} \times \text{rate.numerator} \times 10^{e_{quote}}}{\text{rate.denominator} \times 10^{e_{base}}}\right)$$
  - Same-currency conversion returns input unchanged with rate `'1'`.
  - Returns `{ converted: Money; snapshot: FxSnapshot }` with exact rate text and ISO UTC timestamp.
- **JSON Serialization (`packages/money/src/json.ts`)**:
  - `toJSON(money)` produces `{ amountMinor: string, currency: CurrencyCode }`.
  - `fromJSON(json)` parses and validates structure and currency.
- **ESLint Restriction Against Floats (`eslint.config.mjs`)**:
  - Scoped to `packages/money/src/**/*.ts`:
    - Disallows `parseFloat` (`no-restricted-globals` and `no-restricted-syntax`).
    - Disallows `Number(...)` calls.
    - Disallows `Math.round`, `Math.floor`, `Math.ceil`.
    - Disallows `number` type for properties, parameters, or variables named `amount` / `amountMinor`.

### B. `@internationalota/time` (`packages/time/`)
- Isolated `@js-temporal/polyfill` behind the package boundary.
- `LocalDate` (`YYYY-MM-DD` validated calendar date):
  - `parseLocalDate(str)`: validates ISO-8601 calendar date using Temporal `PlainDate`, rejecting invalid formats, non-existent dates (e.g. `2026-02-29`), and invalid months/days.
  - `isLocalDate(val)` type guard.
- `isValidTimeZone(tz)`: validates IANA timezone identifiers.
- `nightsBetween(checkIn, checkOut)`: computes calendar nights; returns $\ge 0$; throws `InvalidDateRangeError` if `checkOut < checkIn`.
- `startOfLocalDayUtc(date, tz)`: converts local midnight in `tz` to UTC ISO instant string (e.g. `'2026-12-24'` in `Asia/Ho_Chi_Minh` $\to$ `'2026-12-23T17:00:00Z'`).
- `toLocalDateTime(instantUtc, tz)`: converts UTC instant string to local date-time string (`YYYY-MM-DDTHH:mm:ss`).
- `addDays(date, days)`: adds or subtracts calendar days across month, year, and leap-year boundaries.
- Full test coverage of DST transitions in `Europe/Berlin` (spring-forward 2026-03-29: 23 hours; fall-back 2026-10-25: 25 hours) and `Asia/Ho_Chi_Minh` (no DST, UTC+7).

### C. Carry-overs from P1-03 Review (D1–D3)
- **D1**: `createDbClient()` in `packages/db/src/client.ts` now throws fast if `DATABASE_URL` is unset and no `connectionString` option is passed. Hardcoded development fallback URL removed from `client.ts` and `drizzle.config.ts`. Verified with unit test in `packages/db/test/db.spec.ts`.
- **D2**: `"db:migrate"` script in `packages/db/package.json` updated to `"pnpm build && node dist/migrate.js"`. `pnpm db:migrate` succeeds on a fresh clone without prior manual compilation.
- **D3**: Removed broken `"./test"` entry from `exports` in `packages/db/package.json`.

---

## Files created/modified/deleted

- **Modified**:
  - `apps/api/src/health.controller.spec.ts`: provides default test `DATABASE_URL` in `beforeAll` for local isolated test runs per D1.
  - `eslint.config.mjs`: added scoped rules for `packages/money/src/**/*.ts` prohibiting `parseFloat`, `Number(...)`, `Math.round/floor/ceil`, and `number` amounts.
  - `packages/db/drizzle.config.ts`: removed hardcoded fallback URL.
  - `packages/db/package.json`: updated `db:migrate` script and removed `./test` export.
  - `packages/db/src/client.ts`: throw Error when `DATABASE_URL` and `connectionString` are unset.
  - `packages/db/test/db.spec.ts`: added unit tests asserting `createDbClient()` throws on missing credentials.
  - `pnpm-lock.yaml`: recorded additions of `@js-temporal/polyfill` and `fast-check`.

- **Created**:
  - `packages/money/package.json`
  - `packages/money/tsconfig.json`
  - `packages/money/tsconfig.build.json`
  - `packages/money/src/currencies.ts`
  - `packages/money/src/decimal.ts`
  - `packages/money/src/errors.ts`
  - `packages/money/src/money.ts`
  - `packages/money/src/allocate.ts`
  - `packages/money/src/rate.ts`
  - `packages/money/src/rounding.ts`
  - `packages/money/src/format.ts`
  - `packages/money/src/fx.ts`
  - `packages/money/src/json.ts`
  - `packages/money/src/index.ts`
  - `packages/money/test/money.spec.ts`
  - `packages/money/test/money.pbt.spec.ts`
  - `packages/time/package.json`
  - `packages/time/tsconfig.json`
  - `packages/time/tsconfig.build.json`
  - `packages/time/src/errors.ts`
  - `packages/time/src/time.ts`
  - `packages/time/src/index.ts`
  - `packages/time/test/time.spec.ts`
  - `reports/TASK-P1-04-report.md`

- **Deleted**:
  - None.

---

## Technical decisions made

1. **Exact Decimal Parsing without Floating-Point**:
   `decimal(str)` splits on decimal point, computes $\text{denominator} = 10^k$, $\text{numerator} = \text{int} \times 10^k + \text{frac}$, and reduces via integer GCD. This maintains exact integer fractions and stores the exact input string for snapshots.
2. **Deterministic Allocation**:
   `allocate` computes quotient $q_i = \lfloor (\text{amount} \times r_i) / \sum r \rfloor$ and remainder $m_i = (\text{amount} \times r_i) \pmod{\sum r}$. Units of leftover remainder $L$ are awarded to the largest $m_i$ first, tie-breaking by original index ascending. This ensures $\sum \text{parts} = \text{input}$ strictly.
3. **Temporal Isolation**:
   `@js-temporal/polyfill` is encapsulated inside `packages/time`. All public APIs accept and return standard strings (`LocalDate` as `YYYY-MM-DD`, UTC instants as ISO-8601, and local date-time strings). When Node natively supports `Temporal`, the polyfill can be swapped without touching any consumers.
4. **Rounding Modes**:
   Explicit enum `RoundingMode` (`HALF_UP`, `HALF_EVEN`, `DOWN`, `UP`) is required on all rate applications and conversions, avoiding any implicit default rounding mode across financial calculations.

---

## Tests executed (exact commands)

```bash
# 1. Packages money tests (unit + property-based fast-check >= 1000 runs)
pnpm --filter @internationalota/money test

# 2. Packages time tests (DST transitions + IANA timezones)
pnpm --filter @internationalota/time test

# 3. Database foundation tests (including D1 createDbClient throw)
pnpm --filter @internationalota/db test

# 4. ESLint restriction rule verification
node -e "
const fs = require('fs');
fs.writeFileSync('packages/money/src/test-rule.ts', 'export const x = Math.round(1.5); export const y = parseFloat(\"1.2\");\n');
" && pnpm --filter @internationalota/money lint; rm -f packages/money/src/test-rule.ts

# 5. D1 Proof: createDbClient throws without fallback credentials
node -e "delete process.env.DATABASE_URL; process.env.NODE_ENV='production'; import('./packages/db/dist/client.js').then(m => m.createDbClient()).catch(e => console.log('D1 PROOF:', e.message))"

# 6. D2 Proof: pnpm db:migrate builds first on clean tree
rm -rf packages/db/dist && DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm db:migrate

# 7. D3 Proof: packages/db exports does not contain broken ./test
node -e "const pkg = require('./packages/db/package.json'); console.log('D3 PROOF exports:', JSON.stringify(pkg.exports, null, 2))"

# 8. Full monorepo verification in fresh clone
rm -rf /tmp/p1check-p104 && git clone -b task/P1-04-money-time https://github.com/thutniteso-eng/InternationalOTA.git /tmp/p1check-p104 && cd /tmp/p1check-p104
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm lint:boundaries
pnpm typecheck
pnpm test
pnpm build
pnpm licenses:check
pnpm audit --prod --audit-level high
```

---

## Actual results (paste output summary)

### Acceptance Criteria Examples
```
✓ packages/money - Unit Tests > allocate > splits VND 100,000 3 ways → 33,334 / 33,333 / 33,333
✓ packages/money - Unit Tests > applyRate with 4 RoundingModes > computes 10% commission of USD 0.05 under each rounding mode
    DOWN: 0n (USD 0.00)
    UP: 1n (USD 0.01)
    HALF_UP: 1n (USD 0.01)
    HALF_EVEN: 0n (USD 0.00)
✓ packages/money - Unit Tests > parseMoney and formatMoneyPlain > rejects invalid money strings as specified
    parseMoney('1.234', 'USD') -> InvalidMoneyError: Too many decimal places for currency USD: expected at most 2, got 3
    parseMoney('1000.5', 'VND') -> InvalidMoneyError: Too many decimal places for currency VND: expected at most 0, got 1
    parseMoney('1000.0', 'VND') -> InvalidMoneyError: Too many decimal places for currency VND: expected at most 0, got 1
✓ packages/money - Unit Tests > JSON serialization > round-trips through toJSON and fromJSON
```

### Property-Based Tests (fast-check $\ge 1000$ runs each)
```
✓ packages/money - Property-Based Tests (fast-check >= 1000 runs) > allocate sum invariant: sum of parts strictly equals input amount (1000 runs) (241ms)
✓ packages/money - Property-Based Tests (fast-check >= 1000 runs) > add commutative property: add(a, b) === add(b, a) (1000 runs)
✓ packages/money - Property-Based Tests (fast-check >= 1000 runs) > add associative property: add(add(a, b), c) === add(a, add(b, c)) (1000 runs)
✓ packages/money - Property-Based Tests (fast-check >= 1000 runs) > parseMoney ∘ formatMoneyPlain round-trip for every supported currency (1000 runs)
✓ packages/money - Property-Based Tests (fast-check >= 1000 runs) > convert with rate 1 is identity for any currency and rounding mode (1000 runs)
```

### Time & DST Tests
```
✓ packages/time - Unit Tests > startOfLocalDayUtc and DST transitions > computes start of day in Asia/Ho_Chi_Minh (UTC+7, no DST) (7ms)
    2026-12-24 Asia/Ho_Chi_Minh -> 2026-12-23T17:00:00Z
✓ packages/time - Unit Tests > startOfLocalDayUtc and DST transitions > handles Europe/Berlin spring-forward DST transition (2026-03-29) (2ms)
    2026-03-29 Europe/Berlin start: 2026-03-28T23:00:00Z
    2026-03-30 Europe/Berlin start: 2026-03-29T22:00:00Z
    Duration: 23 hours
✓ packages/time - Unit Tests > startOfLocalDayUtc and DST transitions > handles Europe/Berlin fall-back DST transition (2026-10-25) (1ms)
    2026-10-25 Europe/Berlin start: 2026-10-24T22:00:00Z
    2026-10-26 Europe/Berlin start: 2026-10-25T23:00:00Z
    Duration: 25 hours
✓ packages/time - Unit Tests > nightsBetween > throws InvalidDateRangeError when checkOut < checkIn (1ms)
```

### D1–D3 Carry-Over Proofs
- **D1 Proof**:
```
$ node -e "delete process.env.DATABASE_URL; process.env.NODE_ENV='production'; import('./packages/db/dist/client.js').then(m => m.createDbClient()).catch(e => console.log('D1 PROOF:', e.message))"
D1 PROOF: DATABASE_URL environment variable is required to create a database client, or provide connectionString in options
```

- **D2 Proof**:
```
$ rm -rf packages/db/dist && DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm db:migrate

> internationalota@0.0.1 db:migrate /home/iteso/projects/InternationalOTA
> pnpm --filter @internationalota/db run db:migrate

> @internationalota/db@0.0.1 db:migrate /home/iteso/projects/InternationalOTA/packages/db
> pnpm build && node dist/migrate.js

> @internationalota/db@0.0.1 build /home/iteso/projects/InternationalOTA/packages/db
> tsc -p tsconfig.build.json

Running database migrations...
Database migrations completed successfully.
```

- **D3 Proof**:
```
$ node -e "const pkg = require('./packages/db/package.json'); console.log('D3 PROOF exports:', JSON.stringify(pkg.exports, null, 2))"
D3 PROOF exports: {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  },
  "./schema": {
    "types": "./dist/schema/index.d.ts",
    "import": "./dist/schema/index.js",
    "default": "./dist/schema/index.js"
  }
}
```

### ESLint Restriction Rule Proof
```
/home/iteso/projects/InternationalOTA/packages/money/src/test-rule.ts
  1:18  error  Math.round is forbidden in packages/money. Use explicit RoundingMode on integers/bigints          no-restricted-syntax
  1:52  error  Unexpected use of 'parseFloat'. parseFloat is forbidden in packages/money. Use bigint or Decimal  no-restricted-globals
  1:52  error  parseFloat is forbidden in packages/money                                                         no-restricted-syntax
```

### Fresh Clone Verification Sequence
```
$ pnpm install --frozen-lockfile
Done in 2.3s using pnpm v10.29.3

$ pnpm format:check
All matched files use Prettier code style!

$ pnpm lint
✔ eslint passed on all packages and tools (0 warnings, 0 errors)

$ pnpm lint:boundaries
✔ no dependency violations found (13 modules, 18 dependencies cruised)

$ pnpm typecheck
✔ tsc --noEmit passed across all packages and apps

$ pnpm test
Test Files  7 passed (7)
Tests       90 passed (90)

$ pnpm build
✔ packages/db build done
✔ packages/money build done
✔ packages/shared build done
✔ packages/time build done
✔ apps/api build done
✔ apps/web build done (Next.js 16.4.6 optimized production build)

$ pnpm licenses:check
✅ All 352 package licenses verified successfully.

$ pnpm audit --prod --audit-level high
No known vulnerabilities found
```

### GitHub Actions CI Verification
- **Run URL**: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/43123412036
- **Status**: Completed successfully (`verify` in 1m21s, `security` in 23s)
- **Head commit**: `5f2a3de242482964361993a8c942aba5a625bbd0`

---

## Known limitations

1. Static currency table is limited to the 10 MVP currencies (VND, USD, EUR, GBP, AUD, SGD, THB, CNY, KRW, JPY). Full ISO 4217 currency and country tables will be added in P1-05.
2. FX conversion assumes given exchange rates are expressed relative to major currency units (e.g. 1 USD = 25,400 VND). Live rate fetching and automated FX rate ingestion are out of scope.

---

## Deviations from spec (and why)

None. All requirements, acceptance criteria, property-based tests, and carry-overs were implemented strictly as specified.

---

## Remaining risks

None identified. Monorepo builds, typechecks, lints, and passes all tests deterministically without floating-point math in financial code.
