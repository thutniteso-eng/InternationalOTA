# TASK P1-05 — Reference data (+ P1-04 carry-overs)

## OBJECTIVE
Authoritative, repeatable reference tables for countries (ISO 3166-1), currencies (ISO 4217), platform languages (BCP 47) and time zones (IANA), loaded by an idempotent seed — plus the money/time fixes found in the P1-04 review.

## BACKGROUND
Read: `docs/ENGINEERING_STANDARDS.md`, D-011 (forward-only migrations). Existing packages: `@internationalota/db`, `@internationalota/money` (10 currencies hard-coded), `@internationalota/time`.

## SCOPE
### A. Schema `reference` (new Drizzle schema + migration)
| Table | Key | Columns |
|---|---|---|
| `reference.countries` | `alpha2` char(2) | `alpha3` char(3) unique, `numeric` char(3) unique, `name_en` text |
| `reference.currencies` | `code` char(3) | `numeric` char(3), `minor_units` smallint (ISO 4217; NULL where ISO says N.A.), `name_en`, `enabled_for_sale` boolean default false |
| `reference.languages` | `tag` text (BCP 47) | `name_en`, `name_native`, `enabled` boolean |
| `reference.time_zones` | `name` text (IANA canonical) | `country_alpha2` nullable FK → countries |

All with `created_at/updated_at`. Seed data lives in committed JSON files under `packages/db/reference-data/` with a `SOURCES.md` stating where each file came from, the source licence and the generation date.

### B. Data generation (one-off script, output committed)
- `packages/db/scripts/generate-reference-data.ts`. Allowed **dev-only** dependencies for this script: `i18n-iso-countries` (MIT), `currency-codes` (MIT). Record their licences in `SOURCES.md`. Runtime code must not depend on them.
- Languages: only rows `vi` (enabled), `en` (enabled), `ko`, `zh-Hans`, `ja` (disabled).
- Time zones: IANA **canonical** names. Trap: ICU/`Intl.supportedValuesOf('timeZone')` may return legacy CLDR ids such as `Asia/Saigon`. The table must contain `Asia/Ho_Chi_Minh`, and a test must assert `Asia/Saigon` is not present as a canonical row.

### C. Idempotent seed
- `pnpm db:seed` (builds db package first, like `db:migrate`) upserts from the JSON files. Re-running changes nothing (assert row counts and `updated_at` unchanged on second run).
- CI runs `db:migrate` then `db:seed` before tests.

### D. Consistency checks between packages (tests)
- Every currency in `@internationalota/money` `SUPPORTED_CURRENCIES` exists in `currencies.json` with the **same** exponent and is `enabled_for_sale = true`; no other currency is enabled.
- `Asia/Ho_Chi_Minh`, `Europe/Berlin`, `UTC` handling stays correct in `@internationalota/time`.

### E. Carry-overs from P1-04 review (mandatory)
- **E1** `convert()` must reject a rate ≤ 0 (`InvalidRateError`) for cross-currency conversion. `applyRate` may accept negative/zero (discounts), document that.
- **E2** For cross-currency `convert()`, `source` and `asOf` are **required** (no `'manual'` / `now()` defaults — an FX snapshot must record where and when the rate came from). Same-currency identity may keep defaults. `asOf` must be a valid ISO-8601 UTC instant.
- **E3** `isValidTimeZone()` must accept IANA names only (reject offset strings such as `+07:00`), with tests.

## OUT OF SCOPE
Live FX rates, admin UI for reference data, translations of country names beyond `name_en`, any business table.

## ACCEPTANCE CRITERIA
- Counts reported: countries ≈ 249, currencies ≈ 180, languages 5 (2 enabled), time zones (canonical) — exact numbers in report.
- Spot checks in tests: `VN/VNM/704`, `US/USA/840`; `VND` minor units 0, `USD` 2, `JPY` 0, `KWD` 3; `Asia/Ho_Chi_Minh` → `VN`.
- Seed idempotency proven; consistency tests (D) pass; E1–E3 proven with tests.
- Fresh clone: format:check, lint, lint:boundaries, typecheck, db:migrate, db:seed, test, build, licenses:check all exit 0; CI green.

## DELIVERABLES
Branch `task/P1-05-reference-data`, PR `[P1-05] Reference data`, report `reports/TASK-P1-05-report.md`.
