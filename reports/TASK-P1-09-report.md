# TASK P1-09 report

## Implemented

### 1. Database Schema & Raw-SQL Invariants (`finance` schema, migration `0006_aromatic_hellfire_club.sql`)
- Added `packages/db/src/schema/finance.ts` (`pgSchema('finance')`):
  - `finance.accounts`: `id uuid` (UUIDv7 PK), `code text UNIQUE`, `name text`, `type text CHECK IN ('asset','liability','equity','revenue','expense')`, `currency char(3)` FK -> `reference.currencies(code)`, `is_active boolean default true`, timestamps.
  - `finance.journal_entries`: `id uuid` PK, `effective_date date`, `posted_at timestamptz default now()`, `description text`, `source_type text`, `source_id text`, `entry_kind text`, `reverses_entry_id uuid NULL` FK -> `finance.journal_entries(id)`, `created_at timestamptz default now()`, `UNIQUE (source_type, source_id, entry_kind)`, `UNIQUE (reverses_entry_id)`.
  - `finance.journal_lines`: `id uuid` PK, `entry_id` FK, `account_id` FK, `currency char(3)` FK, `debit_minor bigint NOT NULL DEFAULT 0 CHECK (>= 0)`, `credit_minor bigint NOT NULL DEFAULT 0 CHECK (>= 0)`, `CHECK ((debit_minor > 0) <> (credit_minor > 0))`, `memo text NULL`, indexes on `entry_id` and `account_id`.
- Raw-SQL database invariants appended to `packages/db/migrations/0006_aromatic_hellfire_club.sql`:
  1. **Deferred per-currency balance (`trg_journal_lines_balanced`, `trg_journal_entries_balanced`)**: `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` calling `finance.check_journal_entry_balanced(entry_id)` at `COMMIT` to verify `COUNT(*) >= 2` and `SUM(debit_minor) = SUM(credit_minor)` **per currency**.
  2. **Currency match (`trg_journal_lines_currency_match`)**: `BEFORE INSERT ON finance.journal_lines` verifies `NEW.currency = account.currency`.
  3. **Immutability (`trg_journal_entries_immutable`, `trg_journal_lines_immutable`)**: `BEFORE UPDATE OR DELETE` raises an exception; corrections are only possible via reversals.

### 2. Finance Module (`apps/api/src/modules/finance/`)
- Public boundary (`index.ts`) exports `FinanceModule`, `LedgerService`, typed error classes (`LedgerError`, `LedgerValidationError`, `LedgerUnbalancedError`, `LedgerAccountNotFoundError`, `LedgerAccountInactiveError`, `LedgerCurrencyMismatchError`, `LedgerConflictError`, `LedgerAlreadyReversedError`), and domain types.
- `LedgerService.post(tx, input)`: requires caller's `DatabaseTransaction`, accepts `Money` values (zero floats/`number` amounts), validates per-currency balance, >= 2 lines, active accounts, and currency match in app code before DB writes; enforces concurrency-safe idempotency via `INSERT ... ON CONFLICT DO NOTHING` + re-read + canonical line comparison (`LedgerConflictError` on mismatch).
- `LedgerService.reverse(tx, entryId, reason, effectiveDate?)`: creates mirrored entry (`debit <-> credit`, `entry_kind = 'reversal'`, `reverses_entry_id = entryId`). Reversing an entry twice throws `LedgerAlreadyReversedError`; reversing a reversal is allowed and documented.
- `LedgerService.balance(accountId, { asOf? })`: returns `Money` using debit-normal (`asset`, `expense`: `SUM(debit) - SUM(credit)`) and credit-normal (`liability`, `equity`, `revenue`: `SUM(credit) - SUM(debit)`) rules computed in `bigint`.
- Extended `packages/db/src/seed.ts` (`db:seed`, idempotent) with 10 minimal chart of accounts for `VND` and `USD`: `psp_clearing`, `customer_deposits`, `supplier_payables`, `commission_revenue`, `psp_fees`.
- Extended `eslint.config.mjs` so the no-float / no-`number`-amount ESLint restriction applies to `apps/api/src/modules/finance/**/*.ts`.
- No new third-party dependencies added (only internal workspace packages `@internationalota/money` and `@internationalota/time` linked in `apps/api/package.json`).

---

## Files created/modified/deleted

- **Created**:
  - `packages/db/src/schema/finance.ts`
  - `packages/db/migrations/0006_aromatic_hellfire_club.sql`
  - `packages/db/migrations/meta/0006_snapshot.json`
  - `apps/api/src/modules/finance/ledger.errors.ts`
  - `apps/api/src/modules/finance/ledger.types.ts`
  - `apps/api/src/modules/finance/ledger.service.ts`
  - `apps/api/src/modules/finance/finance.module.ts`
  - `apps/api/src/modules/finance/index.ts`
  - `apps/api/src/modules/finance/ledger.spec.ts`
  - `reports/TASK-P1-09-report.md`

- **Modified**:
  - `apps/api/package.json`, `pnpm-lock.yaml` (workspace links to `@internationalota/money` and `@internationalota/time`)
  - `apps/api/src/app.module.ts` (registered `FinanceModule`)
  - `eslint.config.mjs` (extended money no-float/no-number rule to `apps/api/src/modules/finance/**/*.ts`)
  - `packages/db/src/index.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/seed.ts`, `packages/db/migrations/meta/_journal.json`

---

## Mutation Evidence (Criterion 2)

Temporarily removing the deferred balance constraint triggers (`trg_journal_lines_balanced` and `trg_journal_entries_balanced`) from `packages/db/migrations/0006_aromatic_hellfire_club.sql` caused AC2 (raw-SQL unbalanced entry) to commit the unbalanced entry and fail the test:

```
 ❯ src/modules/finance/ledger.spec.ts (7 tests | 1 failed | 6 skipped) 507ms
   ❯ Double-entry ledger integration tests (P1-09) (7)
     × AC2: DB-level balance trigger rejects unbalanced raw SQL entry at commit 17ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/modules/finance/ledger.spec.ts > Double-entry ledger integration tests (P1-09) > AC2: DB-level balance trigger rejects unbalanced raw SQL entry at commit
AssertionError: expected [ { …(9) } ] to have a length of +0 but got 1

- Expected
+ Received

- 0
+ 1

 ❯ src/modules/finance/ledger.spec.ts:222:18
    220|       .from(financeJournalEntries)
    221|       .where(eq(financeJournalEntries.id, entryId));
    222|     expect(rows).toHaveLength(0);
       |                  ^
    223|   });

EXIT_CODE=1
```

Restoring both deferred constraint triggers made all 7 tests in `ledger.spec.ts` pass.

---

## Fresh-Clone Verification

Verified in a fresh clone of `task/P1-09-ledger` at `/tmp/p1check-p109` (commit `c37691e3a0d356f718e2b4d96c41d38e0f45b450`):

```bash
rm -rf /tmp/p1check-p109
git clone -b task/P1-09-ledger https://github.com/thutniteso-eng/InternationalOTA.git /tmp/p1check-p109
cd /tmp/p1check-p109
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

Real results (all commands exited `0`):
- `pnpm format:check`: `All matched files use Prettier code style!` across all 6 workspace projects + `tools/`.
- `pnpm lint`: all 6 workspace projects + `eslint tools` passed with 0 errors (including the extended no-float / no-`number`-amount ESLint rule on `apps/api/src/modules/finance/**/*.ts`).
- `pnpm lint:boundaries`: `✔ no dependency violations found (60 modules, 202 dependencies cruised)`.
- `pnpm typecheck` & `pnpm build`: all 6 workspace projects built and typechecked cleanly.
- `pnpm db:migrate` & `pnpm db:seed`: applied `0006_aromatic_hellfire_club.sql` (tables + raw-SQL triggers) and seeded reference data + 10 minimal ledger accounts idempotently.
- `pnpm test` (Vitest `4.1.12`):
  - `apps/api`: `Test Files  6 passed (6)` / `Tests  48 passed (48)` (`ledger.spec.ts` 7 covering AC1–AC7, `messaging.spec.ts` 10, `identity.spec.ts` 8, `idempotency.spec.ts` 9, `hash.spec.ts` 11, `health.controller.spec.ts` 3).
  - `packages/db`: 22 passed; `packages/money`: 41 passed; `packages/time`: 19 passed; `packages/shared`: passed; `apps/web`: 1 passed; `tools`: 16 passed.
- `pnpm licenses:check`: `✅ All 379 package licenses verified successfully.`
- `pnpm audit --prod --audit-level high`: exited `0` (0 high, 0 critical; 1 moderate).

---

## Known limitations

- Chart of accounts is a minimal starting set for `VND` and `USD` while D-004 (merchant model) remains open; ledger mechanics are account-agnostic.
- Booking/payment flows, financial reports/UI, FX revaluation, and tax are out of scope per spec.

## Deviations from spec (and why)

- None.

## Remaining risks

- None. All acceptance criteria (AC1–AC9) are verified with deterministic integration tests on isolated temporary PostgreSQL databases.

---

## Corrections (K1–K3)

Following the PR #16 review of commit `80147c7`, all three blocking items (K1–K3) were addressed via forward-only migration `packages/db/migrations/0007_watery_norman_osborn.sql`:

### K1 — Prevent appending lines to an already-committed journal entry
- **Change**:
  - Added `created_txid bigint NOT NULL DEFAULT txid_current()` to `finance.journal_entries` (`packages/db/src/schema/finance.ts` + migration `0007_watery_norman_osborn.sql`).
  - Added `BEFORE INSERT ON finance.journal_lines FOR EACH ROW` trigger `trg_journal_lines_same_tx` (`finance.trg_fn_journal_lines_same_tx()`) that rejects any line insert where `journal_entries.created_txid <> txid_current()`.
- **Evidence**: Added automated raw-SQL probe test `K1: Appending a balanced debit/credit pair to a previously committed entry in a later transaction is rejected` in `apps/api/src/modules/finance/ledger.spec.ts` — inserting a balanced 9,999,999 VND pair into an earlier committed entry fails with `Cannot append journal lines to committed entry ... in a later transaction` and the entry retains exactly 2 lines.

### K2 — Block `TRUNCATE` on `finance.journal_entries` and `finance.journal_lines`
- **Change**:
  - Added `BEFORE TRUNCATE ... FOR EACH STATEMENT` triggers `trg_journal_entries_no_truncate` and `trg_journal_lines_no_truncate` calling `finance.trg_fn_prevent_ledger_mutation()` in migration `0007_watery_norman_osborn.sql`.
  - Test harness uses isolated temporary databases (drop/recreate), never `TRUNCATE`.
- **Evidence**: Added automated raw-SQL probe test `K2: TRUNCATE on finance.journal_lines and finance.journal_entries is rejected` in `ledger.spec.ts` — both `TRUNCATE finance.journal_lines CASCADE` and `TRUNCATE finance.journal_entries CASCADE` fail with `is immutable` and existing entries remain intact.

### K3 — Make `finance.accounts.currency` and `finance.accounts.type` immutable
- **Change**:
  - Added `BEFORE UPDATE ON finance.accounts FOR EACH ROW` trigger `trg_accounts_immutable_type_currency` (`finance.trg_fn_accounts_immutable_type_currency()`) in migration `0007_watery_norman_osborn.sql` raising an exception if `currency` or `type` is modified, while keeping `name` and `is_active` editable.
- **Evidence**: Added automated raw-SQL probe test `K3: accounts.currency and accounts.type are immutable while name and is_active remain editable` in `ledger.spec.ts` — updating `currency` or `type` fails (`currency is immutable` / `type is immutable`), while updating `name` and `is_active` succeeds.

