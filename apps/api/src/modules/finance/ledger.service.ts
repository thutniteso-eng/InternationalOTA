import {
  type AccountType,
  and,
  type DatabaseClient,
  type DatabaseTransaction,
  eq,
  type FinanceAccount,
  financeAccounts,
  financeJournalEntries,
  financeJournalLines,
  inArray,
  lte,
  sql,
} from '@internationalota/db';
import { createMoney, type CurrencyCode, type Money } from '@internationalota/money';
import {
  LEDGER_BOOKING_EXPECTATION_PORT,
  LEDGER_PAYMENT_EXPECTATION_PORT,
  type ReconciliationFinding,
} from '@internationalota/shared';
import { type LocalDate, parseLocalDate } from '@internationalota/time';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DRIZZLE_DB } from '../../database/database.module.js';
import type { LedgerBookingExpectationPort } from '../booking/index.js';
import type { LedgerPaymentExpectationPort } from '../payments/index.js';
import {
  LedgerAccountInactiveError,
  LedgerAccountNotFoundError,
  LedgerAlreadyReversedError,
  LedgerConflictError,
  LedgerCurrencyMismatchError,
  LedgerUnbalancedError,
  LedgerValidationError,
} from './ledger.errors.js';
import type {
  BalanceQueryOptions,
  PostedJournalEntry,
  PostJournalEntryInput,
  PostJournalLineInput,
} from './ledger.types.js';

interface CanonicalLine {
  accountId: string;
  currency: string;
  debitMinor: bigint;
  creditMinor: bigint;
}

function canonicalizeLines(lines: readonly CanonicalLine[]): string {
  return [...lines]
    .sort((a, b) => {
      if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
      if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
      if (a.debitMinor !== b.debitMinor) return a.debitMinor < b.debitMinor ? -1 : 1;
      if (a.creditMinor !== b.creditMinor) return a.creditMinor < b.creditMinor ? -1 : 1;
      return 0;
    })
    .map(
      (l) => `${l.accountId}|${l.currency}|${l.debitMinor.toString()}|${l.creditMinor.toString()}`,
    )
    .join('\n');
}

function isPgUniqueViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const pgErr = err as { code?: string; constraint?: string; cause?: unknown };
  if (pgErr.code === '23505' && pgErr.constraint === constraintName) {
    return true;
  }
  if (pgErr.cause) {
    return isPgUniqueViolation(pgErr.cause, constraintName);
  }
  return false;
}

/**
 * Double-entry ledger service (`finance` schema).
 *
 * Normal balance convention:
 * - Debit-normal accounts (`asset`, `expense`): `balance = SUM(debit_minor) - SUM(credit_minor)`
 * - Credit-normal accounts (`liability`, `equity`, `revenue`): `balance = SUM(credit_minor) - SUM(debit_minor)`
 *
 * Reversal convention:
 * - Each journal entry can be reversed at most once (`UNIQUE (reverses_entry_id)`).
 * - Reversing a reversal IS allowed: the new reversal points to the prior reversal's `id`,
 *   effectively re-establishing the original economic impact while preserving full auditability.
 */
@Injectable()
export class LedgerService implements OnModuleInit {
  private bookingExpectationPort: LedgerBookingExpectationPort | null = null;
  private paymentExpectationPort: LedgerPaymentExpectationPort | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  onModuleInit(): void {
    if (!this.moduleRef) {
      return;
    }
    try {
      this.bookingExpectationPort = this.moduleRef.get<LedgerBookingExpectationPort>(
        LEDGER_BOOKING_EXPECTATION_PORT,
        { strict: false },
      );
    } catch {
      this.bookingExpectationPort = null;
    }
    try {
      this.paymentExpectationPort = this.moduleRef.get<LedgerPaymentExpectationPort>(
        LEDGER_PAYMENT_EXPECTATION_PORT,
        { strict: false },
      );
    } catch {
      this.paymentExpectationPort = null;
    }
  }

  /**
   * Posts a balanced journal entry inside the caller's Drizzle transaction.
   *
   * Idempotent by `(sourceType, sourceId, entryKind)`:
   * - Uses `INSERT ... ON CONFLICT DO NOTHING` + re-read so concurrent calls are race-free.
   * - If an entry with the same key already exists with identical lines, returns it with
   *   `idempotentReplay: true`.
   * - If it exists with different lines, throws `LedgerConflictError`.
   */
  async post(tx: DatabaseTransaction, input: PostJournalEntryInput): Promise<PostedJournalEntry> {
    const effectiveDate = parseLocalDate(input.effectiveDate);

    if (!input.description.trim()) {
      throw new LedgerValidationError('Journal entry description is required');
    }
    if (!input.sourceType.trim() || !input.sourceId.trim() || !input.entryKind.trim()) {
      throw new LedgerValidationError('sourceType, sourceId, and entryKind are required');
    }
    if (input.lines.length < 2) {
      throw new LedgerValidationError('Journal entry must have at least 2 lines');
    }

    // Validate positive amounts and per-currency balance in bigint minor units
    const totalsByCurrency = new Map<CurrencyCode, { debit: bigint; credit: bigint }>();
    const requestedCanonical: CanonicalLine[] = [];

    for (const line of input.lines) {
      if (line.amount.amountMinor <= 0n) {
        throw new LedgerValidationError('Journal line amount must be strictly positive');
      }

      const currency = line.amount.currency;
      const totals = totalsByCurrency.get(currency) ?? { debit: 0n, credit: 0n };
      const debitMinor = line.side === 'debit' ? line.amount.amountMinor : 0n;
      const creditMinor = line.side === 'credit' ? line.amount.amountMinor : 0n;

      totals.debit += debitMinor;
      totals.credit += creditMinor;
      totalsByCurrency.set(currency, totals);

      requestedCanonical.push({
        accountId: line.accountId,
        currency,
        debitMinor,
        creditMinor,
      });
    }

    for (const [currency, totals] of totalsByCurrency.entries()) {
      if (totals.debit !== totals.credit) {
        throw new LedgerUnbalancedError(currency, totals.debit, totals.credit);
      }
    }

    // Validate all accounts exist, are active, and match line currencies
    const uniqueAccountIds = Array.from(new Set(input.lines.map((l) => l.accountId)));
    const accounts = await tx
      .select()
      .from(financeAccounts)
      .where(inArray(financeAccounts.id, uniqueAccountIds));

    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    for (const line of input.lines) {
      const account = accountsById.get(line.accountId);
      if (!account) {
        throw new LedgerAccountNotFoundError(line.accountId);
      }
      if (!account.isActive) {
        throw new LedgerAccountInactiveError(line.accountId);
      }
      if (account.currency !== line.amount.currency) {
        throw new LedgerCurrencyMismatchError(
          line.accountId,
          account.currency,
          line.amount.currency,
        );
      }
    }

    // Concurrency-safe idempotent insert
    let insertedEntry: typeof financeJournalEntries.$inferSelect | undefined;
    try {
      const [row] = await tx
        .insert(financeJournalEntries)
        .values({
          effectiveDate,
          description: input.description,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          entryKind: input.entryKind,
          reversesEntryId: input.reversesEntryId ?? null,
        })
        .onConflictDoNothing({
          target: [
            financeJournalEntries.sourceType,
            financeJournalEntries.sourceId,
            financeJournalEntries.entryKind,
          ],
        })
        .returning();
      insertedEntry = row;
    } catch (err: unknown) {
      if (isPgUniqueViolation(err, 'journal_entries_reverses_unique') && input.reversesEntryId) {
        throw new LedgerAlreadyReversedError(input.reversesEntryId);
      }
      throw err;
    }

    if (!insertedEntry) {
      // Entry already exists for (sourceType, sourceId, entryKind): re-read and compare lines
      const [existingEntry] = await tx
        .select()
        .from(financeJournalEntries)
        .where(
          and(
            eq(financeJournalEntries.sourceType, input.sourceType),
            eq(financeJournalEntries.sourceId, input.sourceId),
            eq(financeJournalEntries.entryKind, input.entryKind),
          ),
        );

      if (!existingEntry) {
        throw new LedgerConflictError(input.sourceType, input.sourceId, input.entryKind);
      }

      const existingLines = await tx
        .select()
        .from(financeJournalLines)
        .where(eq(financeJournalLines.entryId, existingEntry.id));

      const existingCanonical = canonicalizeLines(
        existingLines.map((l) => ({
          accountId: l.accountId,
          currency: l.currency,
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
        })),
      );

      if (existingCanonical !== canonicalizeLines(requestedCanonical)) {
        throw new LedgerConflictError(input.sourceType, input.sourceId, input.entryKind);
      }

      return {
        entry: existingEntry,
        lines: existingLines,
        idempotentReplay: true,
      };
    }

    const insertedLines = await tx
      .insert(financeJournalLines)
      .values(
        input.lines.map((line) => ({
          entryId: insertedEntry.id,
          accountId: line.accountId,
          currency: line.amount.currency,
          debitMinor: line.side === 'debit' ? line.amount.amountMinor : 0n,
          creditMinor: line.side === 'credit' ? line.amount.amountMinor : 0n,
          memo: line.memo ?? null,
        })),
      )
      .returning();

    return {
      entry: insertedEntry,
      lines: insertedLines,
      idempotentReplay: false,
    };
  }

  /**
   * Reverses an existing journal entry by posting a mirrored entry (debits <-> credits)
   * with `entryKind = 'reversal'` and `reversesEntryId = entryId`.
   *
   * - Reversing the same entry twice throws `LedgerAlreadyReversedError` (enforced both
   *   in application logic and by `UNIQUE (reverses_entry_id)` in PostgreSQL).
   * - Reversing a reversal IS allowed (pointing `reversesEntryId` at the reversal's own `id`).
   */
  async reverse(
    tx: DatabaseTransaction,
    entryId: string,
    reason: string,
    effectiveDate?: LocalDate,
  ): Promise<PostedJournalEntry> {
    const [original] = await tx
      .select()
      .from(financeJournalEntries)
      .where(eq(financeJournalEntries.id, entryId));

    if (!original) {
      throw new LedgerValidationError(`Journal entry not found: ${entryId}`);
    }

    const [existingReversal] = await tx
      .select({ id: financeJournalEntries.id })
      .from(financeJournalEntries)
      .where(eq(financeJournalEntries.reversesEntryId, entryId));

    if (existingReversal) {
      throw new LedgerAlreadyReversedError(entryId);
    }

    const originalLines = await tx
      .select()
      .from(financeJournalLines)
      .where(eq(financeJournalLines.entryId, entryId));

    const mirroredLines: PostJournalLineInput[] = originalLines.map((line) => {
      const isDebit = line.debitMinor > 0n;
      const minorValue = isDebit ? line.debitMinor : line.creditMinor;
      return {
        accountId: line.accountId,
        side: isDebit ? 'credit' : 'debit',
        amount: createMoney(minorValue, line.currency as CurrencyCode),
        memo: line.memo ? `Reversal: ${line.memo}` : `Reversal of ${entryId}`,
      };
    });

    return this.post(tx, {
      effectiveDate: effectiveDate ?? original.effectiveDate,
      description: reason,
      sourceType: original.sourceType,
      sourceId: original.id,
      entryKind: 'reversal',
      reversesEntryId: original.id,
      lines: mirroredLines,
    });
  }

  /**
   * Computes an account's net balance as `Money`, optionally as of `effective_date <= asOf`.
   *
   * Normal balance rule:
   * - Debit-normal (`asset`, `expense`): `SUM(debit_minor) - SUM(credit_minor)`
   * - Credit-normal (`liability`, `equity`, `revenue`): `SUM(credit_minor) - SUM(debit_minor)`
   */
  async balance(accountId: string, options: BalanceQueryOptions = {}): Promise<Money> {
    const [account] = await this.db
      .select()
      .from(financeAccounts)
      .where(eq(financeAccounts.id, accountId));

    if (!account) {
      throw new LedgerAccountNotFoundError(accountId);
    }

    let totalsRow: { totalDebit: string; totalCredit: string } | undefined;

    if (options.asOf) {
      const asOfDate = parseLocalDate(options.asOf);
      const [row] = await this.db
        .select({
          totalDebit: sql<string>`COALESCE(SUM(${financeJournalLines.debitMinor}), 0)::text`,
          totalCredit: sql<string>`COALESCE(SUM(${financeJournalLines.creditMinor}), 0)::text`,
        })
        .from(financeJournalLines)
        .innerJoin(financeJournalEntries, eq(financeJournalLines.entryId, financeJournalEntries.id))
        .where(
          and(
            eq(financeJournalLines.accountId, accountId),
            lte(financeJournalEntries.effectiveDate, asOfDate),
          ),
        );
      totalsRow = row;
    } else {
      const [row] = await this.db
        .select({
          totalDebit: sql<string>`COALESCE(SUM(${financeJournalLines.debitMinor}), 0)::text`,
          totalCredit: sql<string>`COALESCE(SUM(${financeJournalLines.creditMinor}), 0)::text`,
        })
        .from(financeJournalLines)
        .where(eq(financeJournalLines.accountId, accountId));
      totalsRow = row;
    }

    const totalDebit = BigInt(totalsRow?.totalDebit ?? '0');
    const totalCredit = BigInt(totalsRow?.totalCredit ?? '0');

    const isDebitNormal = account.type === 'asset' || account.type === 'expense';
    const netMinor = isDebitNormal ? totalDebit - totalCredit : totalCredit - totalDebit;

    return createMoney(netMinor, account.currency as CurrencyCode);
  }

  /**
   * Idempotently retrieves or creates a ledger account by code inside `tx`.
   */
  async ensureAccount(
    tx: DatabaseTransaction,
    input: {
      readonly code: string;
      readonly name: string;
      readonly type: AccountType;
      readonly currency: CurrencyCode;
    },
  ): Promise<FinanceAccount> {
    await tx
      .insert(financeAccounts)
      .values({
        code: input.code,
        name: input.name,
        type: input.type,
        currency: input.currency,
        isActive: true,
      })
      .onConflictDoNothing({ target: financeAccounts.code });

    const [account] = await tx
      .select()
      .from(financeAccounts)
      .where(eq(financeAccounts.code, input.code))
      .limit(1);

    if (!account) {
      throw new LedgerAccountNotFoundError(input.code);
    }
    if (!account.isActive) {
      throw new LedgerAccountInactiveError(account.id);
    }
    if (account.currency !== input.currency) {
      throw new LedgerCurrencyMismatchError(account.id, account.currency, input.currency);
    }
    if (account.type !== input.type) {
      throw new LedgerValidationError(
        `Account "${input.code}" has type "${account.type}", expected "${input.type}"`,
      );
    }
    return account;
  }

  async getAccountByCode(code: string): Promise<FinanceAccount | null> {
    const [account] = await this.db
      .select()
      .from(financeAccounts)
      .where(eq(financeAccounts.code, code))
      .limit(1);
    return account ?? null;
  }

  /**
   * Read-only reconciliation check (Check 4):
   * - All journal entries balance per currency as of `asOf`.
   * - Per-currency identities:
   *   - `psp_clearing` = Σ captured payments (succeeded + refund_required) - Σ succeeded refunds
   *   - `customer_prepayments` = Σ currently confirmed bookings (excluding cancelled)
   *   - `refunds_payable` = Σ open refunds + Σ unrefunded refund_required attempts
   */
  async runReconciliationChecks(asOf: Date): Promise<readonly ReconciliationFinding[]> {
    if (!this.bookingExpectationPort || !this.paymentExpectationPort) {
      throw new InternalServerErrorException(
        'Ledger reconciliation ports are not available in this application context.',
      );
    }

    const findings: ReconciliationFinding[] = [];

    const unbalancedRes = await this.db.execute(sql`
      SELECT
        jl.entry_id::text AS "entryId",
        TRIM(jl.currency) AS currency,
        (SUM(jl.debit_minor) - SUM(jl.credit_minor))::text AS "diffMinor"
      FROM finance.journal_lines jl
      INNER JOIN finance.journal_entries je ON je.id = jl.entry_id
      WHERE je.posted_at <= ${asOf}
      GROUP BY jl.entry_id, TRIM(jl.currency)
      HAVING SUM(jl.debit_minor) <> SUM(jl.credit_minor)
    `);
    for (const row of unbalancedRes.rows) {
      findings.push({
        code: 'LEDGER_UNBALANCED_ENTRY',
        severity: 'error',
        entityType: 'journal_entry',
        entityId: String(row['entryId']),
        details: {
          currency: String(row['currency']),
          diffMinor: String(row['diffMinor']),
        },
      });
    }

    const ledgerBalRes = await this.db.execute(sql`
      SELECT
        a.code,
        TRIM(a.currency) AS currency,
        a.type,
        COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_minor ELSE 0 END), 0)::text AS "totalDebit",
        COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit_minor ELSE 0 END), 0)::text AS "totalCredit"
      FROM finance.accounts a
      LEFT JOIN finance.journal_lines jl ON jl.account_id = a.id
      LEFT JOIN finance.journal_entries je ON je.id = jl.entry_id AND je.posted_at <= ${asOf}
      WHERE (a.code LIKE 'asset:psp_clearing:%'
          OR a.code LIKE 'liability:customer_prepayments:%'
          OR a.code LIKE 'liability:refunds_payable:%')
      GROUP BY a.id, a.code, TRIM(a.currency), a.type
    `);

    const pspClearingActual = new Map<string, bigint>();
    const prepaymentsActual = new Map<string, bigint>();
    const refundsPayableActual = new Map<string, bigint>();
    const allCurrencies = new Set<string>();

    for (const row of ledgerBalRes.rows) {
      const code = String(row['code']);
      const currency = String(row['currency']);
      allCurrencies.add(currency);
      const hasEntry = row['totalDebit'] !== null || row['totalCredit'] !== null;
      const debit = hasEntry ? BigInt(String(row['totalDebit'])) : 0n;
      const credit = hasEntry ? BigInt(String(row['totalCredit'])) : 0n;

      if (code.startsWith('asset:psp_clearing:')) {
        pspClearingActual.set(currency, (pspClearingActual.get(currency) ?? 0n) + (debit - credit));
      } else if (code.startsWith('liability:customer_prepayments:')) {
        prepaymentsActual.set(currency, (prepaymentsActual.get(currency) ?? 0n) + (credit - debit));
      } else if (code.startsWith('liability:refunds_payable:')) {
        refundsPayableActual.set(
          currency,
          (refundsPayableActual.get(currency) ?? 0n) + (credit - debit),
        );
      }
    }

    const confirmedByCurrency =
      await this.bookingExpectationPort.getConfirmedTotalsByCurrency(asOf);
    const paymentExpectedByCurrency =
      await this.paymentExpectationPort.getPaymentLedgerExpectedTotalsByCurrency(asOf);

    for (const c of confirmedByCurrency.keys()) allCurrencies.add(c);
    for (const c of paymentExpectedByCurrency.keys()) allCurrencies.add(c);

    for (const currency of allCurrencies) {
      const paymentExp = paymentExpectedByCurrency.get(currency) ?? {
        capturedMinor: 0n,
        settledRefundsMinor: 0n,
        openRefundsMinor: 0n,
        unrefundedRefundRequiredMinor: 0n,
      };
      const expectedClearing = paymentExp.capturedMinor - paymentExp.settledRefundsMinor;
      const actualClearing = pspClearingActual.get(currency) ?? 0n;
      if (actualClearing !== expectedClearing) {
        findings.push({
          code: 'LEDGER_PSP_CLEARING_MISMATCH',
          severity: 'error',
          entityType: 'ledger_account',
          entityId: `asset:psp_clearing:${currency}`,
          details: {
            currency,
            actualMinor: actualClearing.toString(),
            expectedMinor: expectedClearing.toString(),
          },
        });
      }

      const expectedPrepayments = confirmedByCurrency.get(currency) ?? 0n;
      const actualPrepayments = prepaymentsActual.get(currency) ?? 0n;
      if (actualPrepayments !== expectedPrepayments) {
        findings.push({
          code: 'LEDGER_CUSTOMER_PREPAYMENTS_MISMATCH',
          severity: 'error',
          entityType: 'ledger_account',
          entityId: `liability:customer_prepayments:${currency}`,
          details: {
            currency,
            actualMinor: actualPrepayments.toString(),
            expectedMinor: expectedPrepayments.toString(),
          },
        });
      }

      const expectedRefundsPayable =
        paymentExp.openRefundsMinor + paymentExp.unrefundedRefundRequiredMinor;
      const actualRefundsPayable = refundsPayableActual.get(currency) ?? 0n;
      if (actualRefundsPayable !== expectedRefundsPayable) {
        findings.push({
          code: 'LEDGER_REFUNDS_PAYABLE_MISMATCH',
          severity: 'error',
          entityType: 'ledger_account',
          entityId: `liability:refunds_payable:${currency}`,
          details: {
            currency,
            actualMinor: actualRefundsPayable.toString(),
            expectedMinor: expectedRefundsPayable.toString(),
          },
        });
      }
    }

    return findings;
  }
}
