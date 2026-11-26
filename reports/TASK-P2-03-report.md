# TASK-P2-03 Implementation & Verification Report

## Summary
- **Branch**: `task/P2-03-pricing`
- **Scope**:
  - **Database schema & forward-only migration** ([0011_charming_carmella_unuscione.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0011_charming_carmella_unuscione.sql), [pricing.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/schema/pricing.ts)):
    - Created PostgreSQL schema `pricing` with insert-only tables `pricing.price_lists`, `pricing.price_list_items`, and `pricing.cancellation_policies`.
    - Trigger `trg_price_lists_single_currency` locks currency per product across versions (raises SQLSTATE `23514` `check_violation` if a second currency is inserted via raw SQL).
    - Immutability triggers (`BEFORE UPDATE OR DELETE` FOR EACH ROW and `BEFORE TRUNCATE` FOR EACH STATEMENT) on all three tables raise SQLSTATE `23001` (`restrict_violation`).
    - Runtime role grants updated in [roles.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/roles.ts): `ota_app` receives only `SELECT, INSERT` on `pricing.*` tables (zero `UPDATE`, `DELETE`, or `TRUNCATE`).
  - **Pricing & Cancellation Policy module** (`apps/api/src/modules/pricing/`):
    - `PricingService.quote({ departureId, pax })`: resolves the highest version covering the departure's `local_date`, computes exact bigint line/total amounts via `packages/money`, counts `seats` strictly where `occupiesSeat === true`, snapshots current cancellation policy rules, reads DB clock `now()` for `quotedAt`, and computes SHA-256 `snapshotHash`.
    - Pure `computeRefund` ([pricing.refund.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/pricing/pricing.refund.ts)): exact bigint millisecond threshold matching, `RoundingMode.DOWN` (floor on non-negative amounts so rounding never favours the platform beyond one minor unit), and `isSameQuote(a, b)` comparing `snapshotHash`.
    - ESLint float ban in `eslint.config.mjs` extended cleanly to `apps/api/src/modules/pricing/**/*.ts`.
    - Admin endpoints (`@Roles('admin', 'operator')`, `@Idempotent()`): create/list versioned price lists and cancellation policies (`422` `i18nKey` on validation errors).
    - Public quote endpoint `GET /catalog/products/:productId/quote` (locale-formatted via `@internationalota/i18n` `formatMoney`, strips internal IDs/`createdBy`, keeps `priceListVersion` & `cancellationPolicyVersion`, `404` on hidden/non-bookable products/departures) + `fromPrice` & `cancellationSummary` integrated onto `GET /catalog/products/:locale/:slug` (acyclic module graph `Pricing -> Inventory -> Catalog -> Supply` with optional DI read ports bound via `ModuleRef` in `CatalogService.onModuleInit`).
  - **Carry-over L1** (`apps/api/src/modules/inventory/inventory.service.ts` + `apps/api/src/modules/catalog/catalog.service.ts`): `InventoryService.hasDepartures(productId)` blocks changing `timeZone` on products with existing departures (`422`, `catalog.product.timeZoneHasDepartures`).
  - **i18n**: Symmetric `vi`/`en` keys added in `packages/i18n/messages/en.json` and `packages/i18n/messages/vi.json`.
- **New Node dependencies**: None (zero new npm packages).

---

## Verbatim Test Output (AC1–AC10)

Run command:
```text
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm --filter @internationalota/api exec vitest run --reporter=verbose src/modules/pricing/pricing.spec.ts
```

Verbatim output:
```text
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC1: exact bigint arithmetic for VND pax mix 2/1/1 (seats=3) and USD 12345x3 359ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC2: date-scoped version resolution picks highest matching version and updates snapshotHash / isSameQuote 168ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC3: immutability triggers block UPDATE/DELETE/TRUNCATE on all 3 pricing tables and runtime role lacks UPDATE/DELETE 272ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC4: currency lock rejects mixed-currency version via API (422) and raw SQL trigger (23514), plus overlapping age bands (422) 149ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC5: cancellation policy validation rejects non-monotonic, missing 0h, >100%, unsorted, and >10 rules with 422 i18nKey 122ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC6: pure computeRefund table for VND (floor rounding) and USD 999 @ 50% -> 499 2ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC7: quote typed errors (no_price, no_policy, pax_type_not_offered, invalid_pax) and 404 on draft product 194ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC8: public quote strips internal ids & formats vi/en currency; product detail exposes fromPrice and cancellationSummary 169ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC9 (L1 carry-over): changing product timeZone is allowed without departures and rejected with 422 once departures exist 132ms
 ✓ src/modules/pricing/pricing.spec.ts > Pricing & Cancellation Policy integration tests (P2-03) > AC10: anonymous returns 401, customer returns 403 on admin pricing endpoints, and @Idempotent replays same version 123ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

---

## Mutation Evidence (AC11)

| Mutation | Change applied temporarily | Killed by | Verbatim failure excerpt |
|---|---|---|---|
| **11(a)** Refund rounding `DOWN` → `HALF_UP` | Changed `RoundingMode.DOWN` to `RoundingMode.HALF_UP` in `pricing.refund.ts` | `AC6` | `expected { refundPercent: 50, refundAmountMinor: 500001n } to match object { refundPercent: 50, refundAmountMinor: 500000n }` |
| **11(b)** Price list resolution picks lowest version | Changed `ORDER BY version DESC` to `ORDER BY version ASC` in `pricing.service.ts` | `AC2` | `AssertionError: expected 1 to be 2 // Object.is equality` |
| **11(c)** Drop immutability triggers | Removed row/truncate immutability triggers from `0011_charming_carmella_unuscione.sql` in isolated temp DB | `AC3` | `AssertionError: expected undefined to be '23001' // Object.is equality` |
| **11(d)** `seats` counting infants | Changed `if (item.occupiesSeat)` to include `reqPax.paxType === 'infant'` in `pricing.service.ts` | `AC1` | `AssertionError: expected 4 to be 3 // Object.is equality` |
| **11(e)** Remove currency-lock trigger | Removed `trg_price_lists_single_currency` from `0011_charming_carmella_unuscione.sql` in isolated temp DB | `AC4` | `AssertionError: expected undefined to be '23514' // Object.is equality` |

---

## Boundaries, Staging & Workspace Verification

### `pnpm lint:boundaries` deliberate violation demo & clean state
With temporary internal import `import type { PricingService as InternalPricingService } from '../pricing/pricing.service.js';` added to `apps/api/src/modules/catalog/catalog.service.ts`:
```text
$ pnpm lint:boundaries

  error no-sibling-module-internal-imports: apps/api/src/modules/catalog/catalog.service.ts → apps/api/src/modules/pricing/pricing.service.ts

x 1 dependency violations (1 errors, 0 warnings). 120 modules, 457 dependencies cruised.

ELIFECYCLE Command failed with exit code 1.
```
After reverting back to barrel `index.ts` imports:
```text
$ pnpm lint:boundaries

✔ no dependency violations found (120 modules, 456 dependencies cruised)
```

### Compiled ESM Load, Staging Deployment & `ota_app` Grants
- Compiled production ESM verification (`pnpm build && node -e "import('./apps/api/dist/app.module.js').then(() => console.log('COMPILED_ESM_LOAD_OK'))"`): `COMPILED_ESM_LOAD_OK`
- Staging tunnel URL (`./scripts/staging-up.sh`): `https://travel-valentine-character-relation.trycloudflare.com` (`/api/health/ready -> 200 OK`)
- Public quote route through staging tunnel:
```text
HTTP/2 404
content-type: application/problem+json; charset=utf-8
{"type":"https://httpstatuses.com/404","title":"Không tìm thấy","status":404,"detail":"Không tìm thấy sản phẩm.","code":"catalog.product.notFound","i18nKey":"catalog.product.notFound","requestId":"01a21a28-9262-7f7d-a0d3-25718c498439"}
HTTP_STATUS:404
```
- Least-privilege `ota_app` privileges in `ota_staging` (`SELECT, INSERT` only — no `UPDATE`/`DELETE`/`TRUNCATE`):
```text
      table_name       |   privileges   
-----------------------+----------------
 cancellation_policies | INSERT, SELECT
 price_list_items      | INSERT, SELECT
 price_lists           | INSERT, SELECT
(3 rows)
```

### Full Monorepo Checks
- `pnpm format:check`: passed
- `pnpm lint`: passed (with float-ban rule enabled on `apps/api/src/modules/pricing/**/*.ts`)
- `pnpm lint:boundaries`: passed (`120 modules, 456 dependencies cruised`, 0 violations)
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm db:generate`: `No schema changes, nothing to migrate` (26 tables)
- `pnpm test`: passed (`apps/api`: 13 files / 100 tests passed; `tools`: 1 file / 16 tests passed; all workspace packages + `apps/web` passed)
- `pnpm licenses:check`: passed (`All 471 package licenses verified successfully`)
- `pnpm audit --prod --audit-level high`: passed (exit 0)
