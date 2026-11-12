# TASK P1-05 report

## Implemented

### A. Database Schema `reference` (`packages/db/src/schema/reference.ts`)
- Defined PostgreSQL schema `reference` using Drizzle ORM pgSchema:
  - `reference.countries`:
    - `alpha2` `char(2)` PRIMARY KEY
    - `alpha3` `char(3)` NOT NULL UNIQUE
    - `numeric` `char(3)` NOT NULL UNIQUE
    - `name_en` `text` NOT NULL
    - `created_at` / `updated_at` `timestamp with time zone` NOT NULL DEFAULT `now()`
  - `reference.currencies`:
    - `code` `char(3)` PRIMARY KEY
    - `numeric` `char(3)`
    - `minor_units` `smallint` (NULL where ISO says N.A.)
    - `name_en` `text` NOT NULL
    - `enabled_for_sale` `boolean` NOT NULL DEFAULT `false`
    - `created_at` / `updated_at` `timestamp with time zone` NOT NULL DEFAULT `now()`
  - `reference.languages`:
    - `tag` `text` PRIMARY KEY (BCP 47 language tag)
    - `name_en` `text` NOT NULL
    - `name_native` `text` NOT NULL
    - `enabled` `boolean` NOT NULL DEFAULT `false`
    - `created_at` / `updated_at` `timestamp with time zone` NOT NULL DEFAULT `now()`
  - `reference.time_zones`:
    - `name` `text` PRIMARY KEY (IANA canonical identifier)
    - `country_alpha2` `char(2)` REFERENCES `reference.countries(alpha2)` (NULL for UTC)
    - `created_at` / `updated_at` `timestamp with time zone` NOT NULL DEFAULT `now()`
- Generated forward-only migration: `packages/db/migrations/0001_colossal_martin_li.sql`.

### B. Reference Data Generation (`packages/db/scripts/generate-reference-data.ts`)
- Implemented reference data extraction script using dev-only packages `i18n-iso-countries` and `currency-codes`:
  - **Countries (`packages/db/reference-data/countries.json`)**:
    - Extracted 250 ISO 3166-1 country entries.
    - Verified all entries have 2-character alpha2, 3-character alpha3, 3-digit numeric code, and English name.
  - **Currencies (`packages/db/reference-data/currencies.json`)**:
    - Extracted 179 ISO 4217 currencies.
    - Flagged exactly the 10 currencies supported by `@internationalota/money` as `enabled_for_sale = true` (`VND`, `USD`, `EUR`, `GBP`, `AUD`, `SGD`, `THB`, `CNY`, `KRW`, `JPY`). All other 169 currencies default to `enabled_for_sale = false`.
  - **Languages (`packages/db/reference-data/languages.json`)**:
    - Exactly 5 platform languages:
      - `vi`: English name "Vietnamese", native name "Tiếng Việt", `enabled = true`
      - `en`: English name "English", native name "English", `enabled = true`
      - `ko`: English name "Korean", native name "한국어", `enabled = false`
      - `zh-Hans`: English name "Simplified Chinese", native name "简体中文", `enabled = false`
      - `ja`: English name "Japanese", native name "日本語", `enabled = false`
  - **Time Zones (`packages/db/reference-data/time-zones.json`)**:
    - Extracted 419 canonical IANA time zones from IANA `zone.tab` plus `UTC`.
    - Handles the IANA time zone trap: `Asia/Ho_Chi_Minh` is mapped to country `VN`. CLDR legacy identifier `Asia/Saigon` is strictly excluded. `UTC` has null `country_alpha2`.
  - **Data Provenance (`packages/db/reference-data/SOURCES.md`)**:
    - Documents standard, upstream package/file source, upstream license, record count, and generation timestamp for all reference data.

### C. Idempotent Seed (`packages/db/src/seed.ts`)
- Implemented `seedReferenceData(db)`:
  - Upserts JSON reference data using `onConflictDoNothing()`.
  - Batched chunk insertion for PostgreSQL parameter limit safety.
  - Ensures repeated runs make zero modifications: row counts and `updated_at` remain identical.
- Added script `"db:seed": "pnpm build && node dist/seed.js"` to `packages/db/package.json` and root wrapper `"db:seed": "pnpm --filter @internationalota/db run db:seed"`.
- Updated `.github/workflows/ci.yml` to run `pnpm db:seed` following `pnpm db:migrate` before test execution.

### D. Consistency & Integration Tests (`packages/db/test/reference.spec.ts`)
- Added comprehensive tests asserting:
  - **Counts**: 250 countries, 179 currencies (10 enabled for sale), 5 languages (2 enabled), 419 canonical time zones.
  - **Spot checks**:
    - `VN`: alpha3 `VNM`, numeric `704`, name "Viet Nam"
    - `US`: alpha3 `USA`, numeric `840`, name "United States of America"
    - `VND`: minor units 0, enabled for sale
    - `USD`: minor units 2, enabled for sale
    - `JPY`: minor units 0, enabled for sale
    - `KWD`: minor units 3, not enabled for sale
    - `Asia/Ho_Chi_Minh` exists and references country `VN`
    - `Asia/Saigon` does NOT exist in canonical time zones
    - `UTC` exists with null `country_alpha2`
  - **Seed Idempotency**: Seeding a second time leaves row counts and `updated_at` timestamps identical to the initial run.
  - **Cross-Package Consistency**:
    - Every currency in `@internationalota/money` `SUPPORTED_CURRENCIES` exists in `currencies.json` with the identical exponent and `enabled_for_sale = true`. No other currency in `currencies.json` has `enabled_for_sale = true`.
    - `Asia/Ho_Chi_Minh`, `Europe/Berlin`, and `UTC` exist in `time_zones.json` and validate cleanly with `@internationalota/time`.

### E. P1-04 Review Carry-overs (E1–E3)
- **E1 (`packages/money/src/fx.ts` & `packages/money/src/rate.ts`)**:
  - `convert()` throws `InvalidRateError` if `rate.numerator <= 0n` for cross-currency conversions.
  - Documented on `applyRate()` that negative and zero decimal rates are explicitly permitted for discounts, fee deductions, and promotions.
  - Added unit tests in `packages/money/test/money.spec.ts`.
- **E2 (`packages/money/src/fx.ts`)**:
  - For cross-currency `convert()`, `options.source` and `options.asOf` are now strictly required (`source` cannot be empty, `asOf` must match ISO-8601 UTC instant regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/` and represent a valid Date). Throws `InvalidFxSnapshotOptionsError` otherwise.
  - Same-currency conversions retain default identity snapshot (`rate: '1'`, `source: 'identity'`).
  - Added unit tests in `packages/money/test/money.spec.ts`.
- **E3 (`packages/time/src/time.ts`)**:
  - `isValidTimeZone(tz)` now checks `/^[+-]/.test(trimmed)` and rejects raw offset strings (e.g. `+07:00`, `-05:00`, `+00:00`, `+07`) before querying `Intl.DateTimeFormat`.
  - Added unit tests in `packages/time/test/time.spec.ts`.

---

## Files created/modified/deleted

- **Modified**:
  - `.github/workflows/ci.yml`: added `pnpm db:seed` step after `pnpm db:migrate`.
  - `package.json`: added root `"db:seed"` script.
  - `packages/db/package.json`: added `i18n-iso-countries`, `currency-codes`, `@internationalota/money`, `@internationalota/time` to `devDependencies`; added `"db:seed"` script.
  - `packages/db/tsconfig.json`: included `scripts/**/*` for TypeScript compilation during lint.
  - `packages/db/tsconfig.build.json`: excluded `scripts/**/*` and `reference-data/**/*` from production distribution build.
  - `packages/db/src/schema/index.ts`: exported `referenceSchema` tables.
  - `packages/money/src/errors.ts`: added `InvalidFxSnapshotOptionsError`.
  - `packages/money/src/fx.ts`: enforced E1 rate $> 0$ and E2 required `source`/`asOf` for cross-currency.
  - `packages/money/src/rate.ts`: added docstring noting discount support for zero/negative rates.
  - `packages/money/src/index.ts`: exported `InvalidFxSnapshotOptionsError`.
  - `packages/money/test/money.spec.ts`: updated conversion test fixtures to supply `source` and `asOf`; added tests for E1 & E2.
  - `packages/money/test/money.pbt.spec.ts`: provided required `source` and `asOf` for property-based conversion tests.
  - `packages/time/src/time.ts`: enforced E3 rejection of raw offset strings in `isValidTimeZone`.
  - `packages/time/test/time.spec.ts`: added tests asserting rejection of offset strings.
  - `pnpm-lock.yaml`: updated with dev-only dependencies.
  - `tools/license-exceptions.json`: added approved dev-only transitive exception for `nub@0.0.0` (`MIT/X11` used by `currency-codes`).

- **Created**:
  - `packages/db/migrations/0001_colossal_martin_li.sql`: Drizzle migration creating `reference` schema and tables.
  - `packages/db/reference-data/countries.json`: 250 ISO 3166-1 countries.
  - `packages/db/reference-data/currencies.json`: 179 ISO 4217 currencies.
  - `packages/db/reference-data/languages.json`: 5 platform languages.
  - `packages/db/reference-data/time-zones.json`: 419 canonical IANA time zones.
  - `packages/db/reference-data/SOURCES.md`: reference data source provenance and licences.
  - `packages/db/scripts/generate-reference-data.ts`: generator script for reference JSON.
  - `packages/db/src/schema/reference.ts`: Drizzle schema definition for `reference` tables.
  - `packages/db/src/seed.ts`: idempotent reference data seeder.
  - `packages/db/test/reference.spec.ts`: reference data verification, idempotency, and cross-package consistency test suite.

---

## Technical decisions made

1. **Canonical IANA Time Zones vs CLDR Legacy Identifiers**:
   `Intl.supportedValuesOf('timeZone')` returns CLDR time zone names which include legacy aliases like `Asia/Saigon` and may omit canonical identifiers. To ensure exact IANA canonical names and clean country mappings, `generate-reference-data.ts` parses the authoritative IANA `zone.tab` table (`/usr/share/zoneinfo/zone.tab`), explicitly mapping `Asia/Ho_Chi_Minh` to `VN` and excluding legacy aliases.
2. **Strict Time Zone Offset Rejection (E3)**:
   `Intl.DateTimeFormat(undefined, { timeZone: tz })` standard implementation accepts raw UTC offset strings such as `+07:00` or `-05:00`. To enforce strict IANA name compliance per E3, `isValidTimeZone(tz)` checks `/^[+-]/.test(trimmed)` and rejects any offset-style strings immediately.
3. **Seed Idempotency Mechanism**:
   The seeder uses `onConflictDoNothing()` on primary key columns (`alpha2`, `code`, `tag`, `name`). This ensures that re-running `pnpm db:seed` does not perform unnecessary updates or alter existing `updated_at` timestamps, maintaining deterministic state across repeated executions.
4. **License Exemption for `nub`**:
   The dev-only package `currency-codes` transitively depends on `nub@0.0.0` which publishes the license identifier `MIT/X11`. Because this is a dev-only dependency approved by the task specification, an exception entry was added to `tools/license-exceptions.json` with documented rationale.

---

## Tests executed (exact commands)

The complete sequence was verified in a fresh clone:
```bash
rm -rf /tmp/p1check-p105
git clone -b task/P1-05-reference-data https://github.com/thutniteso-eng/InternationalOTA.git /tmp/p1check-p105
cd /tmp/p1check-p105
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm lint:boundaries
pnpm typecheck
pnpm build
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm db:migrate
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm db:seed
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm test
pnpm licenses:check
pnpm audit --prod --audit-level high
```

---

## Actual results (paste output summary)

### 1. `pnpm format:check`
```
Checking formatting...
All matched files are use Prettier code style!
```

### 2. `pnpm lint` & `pnpm lint:boundaries`
```
> internationalota@0.0.1 lint /tmp/p1check-p105
> pnpm build:packages && pnpm -r run lint && eslint tools

> internationalota@0.0.1 build:packages /tmp/p1check-p105
> pnpm --filter "./packages/**" build

Scope: 4 of 7 workspace projects
packages/money build$ tsc -p tsconfig.build.json
packages/time build$ tsc -p tsconfig.build.json
packages/shared build$ tsc
packages/db build$ tsc -p tsconfig.build.json

Scope: 6 of 7 workspace projects
packages/money lint$ eslint .
packages/shared lint$ eslint .
packages/time lint$ eslint .
apps/web lint$ eslint .
packages/db lint$ eslint .
apps/api lint$ eslint .

> internationalota@0.0.1 lint:boundaries /tmp/p1check-p105
> depcruise apps/api/src --config .dependency-cruiser.cjs

✔ no dependency violations found (13 modules, 18 dependencies cruised)
```

### 3. `pnpm typecheck` & `pnpm build`
```
> internationalota@0.0.1 typecheck /tmp/p1check-p105
> pnpm build:packages && pnpm -r run typecheck

packages/money typecheck$ tsc --noEmit
packages/shared typecheck$ tsc --noEmit
packages/time typecheck$ tsc --noEmit
apps/web typecheck$ next typegen && tsc --noEmit
packages/db typecheck$ tsc --noEmit
apps/api typecheck$ tsc --noEmit

> internationalota@0.0.1 build /tmp/p1check-p105
> pnpm -r run build

Scope: 6 of 7 workspace projects
packages/money build$ tsc -p tsconfig.build.json
packages/shared build$ tsc
packages/time build$ tsc -p tsconfig.build.json
apps/web build$ next build
packages/db build$ tsc -p tsconfig.build.json
apps/api build$ tsc -p tsconfig.build.json
```

### 4. `pnpm db:migrate` & `pnpm db:seed`
```
> internationalota@0.0.1 db:migrate /tmp/p1check-p105
> pnpm --filter @internationalota/db run db:migrate

> @internationalota/db@0.0.1 db:migrate /tmp/p1check-p105/packages/db
> pnpm build && node dist/migrate.js

Running database migrations...
Database migrations completed successfully.

> internationalota@0.0.1 db:seed /tmp/p1check-p105
> pnpm --filter @internationalota/db run db:seed

> @internationalota/db@0.0.1 db:seed /tmp/p1check-p105/packages/db
> pnpm build && node dist/seed.js

Seeding reference data...
Reference data seeded successfully: 250 countries, 179 currencies, 5 languages, 419 time zones.
```

### 5. `pnpm test` (Full Workspace Test Suite)
```
> internationalota@0.0.1 test /tmp/p1check-p105
> pnpm build:packages && pnpm -r run test && vitest run tools

Scope: 6 of 7 workspace projects
packages/shared: 1 passed (1 test)
packages/time: 19 passed (19 tests) - includes E3 tests
packages/money: 41 passed (36 unit tests + 5 PBT tests >= 1000 runs) - includes E1 & E2 tests
apps/web: 1 passed (1 test)
packages/db: 20 passed (12 db tests + 8 reference & idempotency tests)
apps/api: 3 passed (3 tests)
tools: 16 passed (16 tests)

Test Files  8 passed (8)
Tests       101 passed (101)
```

### 6. Reference Data Spot Checks & Exact Counts (from `packages/db/test/reference.spec.ts`)
```
✓ reference schema data > contains exact expected record counts:
  - Countries: 250
  - Currencies: 179 total (exactly 10 enabled for sale)
  - Languages: 5 total (exactly 2 enabled: vi, en)
  - Time zones: 419 canonical IANA time zones
✓ reference schema data > satisfies country spot checks:
  - VN / VNM / 704 / Viet Nam
  - US / USA / 840 / United States of America
✓ reference schema data > satisfies currency spot checks:
  - VND: minor_units = 0, enabled_for_sale = true
  - USD: minor_units = 2, enabled_for_sale = true
  - JPY: minor_units = 0, enabled_for_sale = true
  - KWD: minor_units = 3, enabled_for_sale = false
✓ reference schema data > satisfies time zone spot checks and Asia/Saigon rejection:
  - Asia/Ho_Chi_Minh maps to country VN
  - Asia/Saigon is NOT present in canonical time zones
  - UTC exists with null country_alpha2
✓ reference schema data > seed is strictly idempotent:
  - 2nd seed run leaves row counts unchanged (250, 179, 5, 419)
  - 2nd seed run leaves updated_at timestamps identical on all tables
✓ cross-package consistency with @internationalota/money:
  - Every currency in SUPPORTED_CURRENCIES exists in currencies.json with matching exponent
  - Every supported currency has enabled_for_sale = true
  - No other currency in currencies.json has enabled_for_sale = true
✓ cross-package consistency with @internationalota/time:
  - Asia/Ho_Chi_Minh, Europe/Berlin, UTC exist in time_zones.json and pass isValidTimeZone()
```

### 7. P1-04 Carry-overs Spot Checks (from `packages/money` and `packages/time` tests)
```
✓ packages/money/test/money.spec.ts:
  - convert rejects rate <= 0 with InvalidRateError (E1)
  - convert requires source and valid ISO-8601 UTC asOf for cross-currency (E2)
  - convert rejects empty source, non-UTC, non-ISO, or invalid dates (E2)
  - applyRate permits negative and zero rates for discounts/rebates (E1)
✓ packages/time/test/time.spec.ts:
  - isValidTimeZone rejects raw offset strings like +07:00, -05:00, +00:00 (E3)
  - isValidTimeZone accepts canonical IANA time zones (Asia/Ho_Chi_Minh, Europe/Berlin, UTC)
```

### 8. `pnpm licenses:check` & `pnpm audit`
```
> internationalota@0.0.1 licenses:check /tmp/p1check-p105
> node tools/check-licenses.mjs

✅ All 357 package licenses verified successfully.
No known vulnerabilities found
```

---

## Known limitations

- `generate-reference-data.ts` reads `/usr/share/zoneinfo/zone.tab` to construct the canonical IANA time zone list. This file is present on standard Linux/POSIX systems and containerized CI runners. Generating reference data on environments lacking `/usr/share/zoneinfo/zone.tab` would require providing the file or running in Docker; runtime code does not run the generation script and uses only the committed `packages/db/reference-data/*.json` files.

---

## Deviations from spec (and why)

- None.

---

## Remaining risks

- None. Database migrations and seeds run deterministically in CI and local environments. All constraints and cross-package relationships are strictly validated by automated tests.
