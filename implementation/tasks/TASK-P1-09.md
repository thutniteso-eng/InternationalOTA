# TASK P1-09 — Double-entry ledger skeleton

## OBJECTIVE
Every movement of money the platform records (customer payment, refund, supplier payable, commission, PSP fee) is a balanced, immutable journal entry. The database itself refuses unbalanced or edited entries, so a bug in application code cannot silently corrupt the books.

## BACKGROUND
Read: `docs/ENGINEERING_STANDARDS.md` (money = bigint minor units + ISO 4217), `@internationalota/money`, `reference.currencies` (P1-05), `OutboxService.enqueue(tx, …)` pattern (P1-08: services that must join the caller's transaction take `tx` explicitly). D-004 (merchant model) is still open, so the chart of accounts below is a minimal starting set and may change; the ledger mechanics must not depend on it.

## SCOPE
### A. Schema `finance` (new Drizzle schema + migration)
- `finance.accounts`: `id uuid` (v7) PK, `code text UNIQUE`, `name text`, `type text CHECK IN ('asset','liability','equity','revenue','expense')`, `currency char(3)` FK → `reference.currencies(code)`, `is_active boolean default true`, timestamps.
- `finance.journal_entries`: `id uuid` PK, `effective_date date`, `posted_at timestamptz default now()`, `description text`, `source_type text`, `source_id text`, `entry_kind text`, `reverses_entry_id uuid NULL` FK → journal_entries, `created_at`.
  - `UNIQUE (source_type, source_id, entry_kind)` — idempotent posting key.
  - `UNIQUE (reverses_entry_id)` — an entry can be reversed at most once.
- `finance.journal_lines`: `id uuid` PK, `entry_id` FK, `account_id` FK, `currency char(3)`, `debit_minor bigint NOT NULL DEFAULT 0 CHECK (>= 0)`, `credit_minor bigint NOT NULL DEFAULT 0 CHECK (>= 0)`, `CHECK ((debit_minor > 0) <> (credit_minor > 0))` (exactly one side), `memo text NULL`.

### B. Database-enforced invariants (raw SQL in the migration is allowed and expected)
1. **Balance:** a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `journal_lines` verifies at **commit** that, for the affected entry, **per currency** Σdebit = Σcredit and the entry has ≥ 2 lines. Unbalanced → the transaction fails.
2. **Currency match:** a line's `currency` must equal its account's `currency` (trigger or composite FK).
3. **Immutability:** `UPDATE` and `DELETE` on `journal_entries` and `journal_lines` raise an exception (triggers). Corrections only via reversal.

### C. Module `apps/api/src/modules/finance/` (public `index.ts`)
- `LedgerService.post(tx, input)` — requires the caller's transaction; input uses `Money` values; validates in app code too (balanced per currency, ≥ 2 lines, accounts active, currencies match) and throws typed errors before hitting the DB.
- **Idempotency:** if `(source_type, source_id, entry_kind)` already exists, return the existing entry **only if its lines are identical**; otherwise throw `LedgerConflictError`. Must be safe under concurrency (use `INSERT … ON CONFLICT DO NOTHING` + re-read, not check-then-insert).
- `LedgerService.reverse(tx, entryId, reason)` — creates the mirrored entry (debits↔credits), `entry_kind = 'reversal'`, `reverses_entry_id` set.
- `LedgerService.balance(accountId, { asOf?: LocalDate })` → `Money` (debit-normal accounts: Σdebit−Σcredit; credit-normal: the opposite; document the rule).
- Seed (extend `db:seed`, idempotent): minimal chart of accounts for `VND` and `USD`: `psp_clearing` (asset), `customer_deposits` (liability), `supplier_payables` (liability), `commission_revenue` (revenue), `psp_fees` (expense).

## OUT OF SCOPE
Booking/payment flows, reports/UI, FX revaluation, multi-entity accounting, tax.

## ACCEPTANCE CRITERIA (integration tests, isolated temporary database)
1. Balanced 2-line and 3-line entries post; balances correct (VND and USD).
2. **DB-level balance:** inserting an unbalanced entry with raw SQL (bypassing `LedgerService`) → commit fails. **Mutation evidence:** drop the deferred trigger → this test fails (paste output).
3. Multi-currency entry balanced in total but not per currency → rejected.
4. Line currency ≠ account currency → rejected.
5. `UPDATE`/`DELETE` on entries or lines via raw SQL → rejected.
6. Reverse → net balance of affected accounts returns to the prior value; reversing the same entry twice → rejected; reversing a reversal is allowed (documented).
7. **Idempotency under concurrency:** 10 concurrent `post` calls with the same source key and identical lines → exactly 1 entry; same key with different lines → `LedgerConflictError`.
8. No `number`/float anywhere in amounts (the existing money ESLint rule must apply to the finance module too).
9. Fresh clone + CI green.

## DELIVERABLES
Branch `task/P1-09-ledger`, PR `[P1-09] Double-entry ledger`, report `reports/TASK-P1-09-report.md` with the mutation output.
