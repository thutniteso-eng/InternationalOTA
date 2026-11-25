import {
  type DatabaseClient,
  eq,
  financeAccounts,
  financeJournalEntries,
  financeJournalLines,
  seedReferenceData,
  sql,
} from '@internationalota/db';
import { createMoney } from '@internationalota/money';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  LedgerAlreadyReversedError,
  LedgerConflictError,
  LedgerCurrencyMismatchError,
  LedgerUnbalancedError,
} from './ledger.errors.js';
import { LedgerService } from './ledger.service.js';

const TEST_AUTH_SECRET = 'p1-09-ledger-test-auth-secret-at-least-32-chars';

async function expectPgError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err: unknown) {
    caught = err;
  }
  if (!caught) {
    expect.unreachable(`Expected PostgreSQL error matching ${pattern}`);
  }
  const e = caught as { message?: string; cause?: { message?: string } };
  const combined = `${e.message ?? ''}\n${e.cause?.message ?? ''}`;
  expect(combined).toMatch(pattern);
}

describe('Double-entry ledger integration tests (P1-09)', () => {
  let app: INestApplication;
  let db: DatabaseClient;
  let ledger: LedgerService;
  let testDb: TestDbInstance;
  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousBossDisabled: string | undefined;

  const accountsByCode = new Map<string, string>();

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousBossDisabled = process.env['PG_BOSS_DISABLED'];

    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['PG_BOSS_DISABLED'] = 'true';

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;

    // Seed reference currencies + minimal chart of accounts (idempotent)
    const firstSeed = await seedReferenceData(testDb.db);
    expect(firstSeed.accounts).toBe(10);
    await seedReferenceData(testDb.db);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
    ledger = moduleFixture.get<LedgerService>(LedgerService);

    const allAccounts = await db.select().from(financeAccounts);
    expect(allAccounts).toHaveLength(10);
    for (const acct of allAccounts) {
      accountsByCode.set(acct.code, acct.id);
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = previousDatabaseUrl;
    }
    if (previousAuthSecret === undefined) {
      delete process.env['BETTER_AUTH_SECRET'];
    } else {
      process.env['BETTER_AUTH_SECRET'] = previousAuthSecret;
    }
    if (previousBossDisabled === undefined) {
      delete process.env['PG_BOSS_DISABLED'];
    } else {
      process.env['PG_BOSS_DISABLED'] = previousBossDisabled;
    }
    if (testDb) {
      await testDb.teardown();
    }
  });

  function acctId(code: string): string {
    const id = accountsByCode.get(code);
    if (!id) {
      throw new Error(`Missing seeded account: ${code}`);
    }
    return id;
  }

  it('AC1: Balanced 2-line (VND) and 3-line (USD) entries post with accurate balances and asOf filtering', async () => {
    // 2-line VND entry: customer deposit received at PSP clearing
    const vndEntry = await db.transaction((tx) =>
      ledger.post(tx, {
        effectiveDate: '2026-11-20',
        description: 'VND customer payment',
        sourceType: 'payment',
        sourceId: 'pay-vnd-001',
        entryKind: 'capture',
        lines: [
          {
            accountId: acctId('psp_clearing_vnd'),
            side: 'debit',
            amount: createMoney(2_500_000n, 'VND'),
          },
          {
            accountId: acctId('customer_deposits_vnd'),
            side: 'credit',
            amount: createMoney(2_500_000n, 'VND'),
          },
        ],
      }),
    );
    expect(vndEntry.idempotentReplay).toBe(false);
    expect(vndEntry.lines).toHaveLength(2);

    expect(await ledger.balance(acctId('psp_clearing_vnd'))).toEqual(
      createMoney(2_500_000n, 'VND'),
    );
    expect(await ledger.balance(acctId('customer_deposits_vnd'))).toEqual(
      createMoney(2_500_000n, 'VND'),
    );

    // 3-line USD entry on a later date: $100.00 split into $85.00 supplier payable + $15.00 commission
    const usdEntry = await db.transaction((tx) =>
      ledger.post(tx, {
        effectiveDate: '2026-11-25',
        description: 'USD booking settlement',
        sourceType: 'booking',
        sourceId: 'bk-usd-001',
        entryKind: 'settlement',
        lines: [
          {
            accountId: acctId('psp_clearing_usd'),
            side: 'debit',
            amount: createMoney(10_000n, 'USD'),
          },
          {
            accountId: acctId('supplier_payables_usd'),
            side: 'credit',
            amount: createMoney(8_500n, 'USD'),
          },
          {
            accountId: acctId('commission_revenue_usd'),
            side: 'credit',
            amount: createMoney(1_500n, 'USD'),
          },
        ],
      }),
    );
    expect(usdEntry.lines).toHaveLength(3);

    expect(await ledger.balance(acctId('psp_clearing_usd'))).toEqual(createMoney(10_000n, 'USD'));
    expect(await ledger.balance(acctId('supplier_payables_usd'))).toEqual(
      createMoney(8_500n, 'USD'),
    );
    expect(await ledger.balance(acctId('commission_revenue_usd'))).toEqual(
      createMoney(1_500n, 'USD'),
    );

    // asOf date before 2026-11-25 excludes the USD entry
    expect(await ledger.balance(acctId('psp_clearing_usd'), { asOf: '2026-11-24' })).toEqual(
      createMoney(0n, 'USD'),
    );
    expect(await ledger.balance(acctId('psp_clearing_usd'), { asOf: '2026-11-25' })).toEqual(
      createMoney(10_000n, 'USD'),
    );
  });

  it('AC2: DB-level balance trigger rejects unbalanced raw SQL entry at commit', async () => {
    const entryId = '019a0000-0000-7000-8000-000000000001';
    const line1Id = '019a0000-0000-7000-8000-000000000002';
    const line2Id = '019a0000-0000-7000-8000-000000000003';

    await expectPgError(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO finance.journal_entries (id, effective_date, description, source_type, source_id, entry_kind)
          VALUES (${entryId}::uuid, '2026-11-25', 'Raw unbalanced entry', 'raw', 'unbal-1', 'test')
        `);
        await tx.execute(sql`
          INSERT INTO finance.journal_lines (id, entry_id, account_id, currency, debit_minor, credit_minor)
          VALUES
            (${line1Id}::uuid, ${entryId}::uuid, ${acctId('psp_clearing_usd')}::uuid, 'USD', 5000, 0),
            (${line2Id}::uuid, ${entryId}::uuid, ${acctId('customer_deposits_usd')}::uuid, 'USD', 0, 4000)
        `);
      }),
      /unbalanced/i,
    );

    // Verify rolled back (no row persisted)
    const rows = await db
      .select()
      .from(financeJournalEntries)
      .where(eq(financeJournalEntries.id, entryId));
    expect(rows).toHaveLength(0);
  });

  it('AC3: Multi-currency entry balanced in total but not per currency is rejected (app & DB)', async () => {
    // 1. App-level rejection
    await expect(
      db.transaction((tx) =>
        ledger.post(tx, {
          effectiveDate: '2026-11-25',
          description: 'Invalid cross-currency entry',
          sourceType: 'test',
          sourceId: 'multi-ccy-app-1',
          entryKind: 'test',
          lines: [
            {
              accountId: acctId('psp_clearing_vnd'),
              side: 'debit',
              amount: createMoney(1000n, 'VND'),
            },
            {
              accountId: acctId('customer_deposits_usd'),
              side: 'credit',
              amount: createMoney(1000n, 'USD'),
            },
          ],
        }),
      ),
    ).rejects.toThrow(LedgerUnbalancedError);

    // 2. DB-level rejection via raw SQL
    const entryId = '019a0000-0000-7000-8000-000000000011';
    const line1Id = '019a0000-0000-7000-8000-000000000012';
    const line2Id = '019a0000-0000-7000-8000-000000000013';

    await expectPgError(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO finance.journal_entries (id, effective_date, description, source_type, source_id, entry_kind)
          VALUES (${entryId}::uuid, '2026-11-25', 'Raw multi-ccy unbalanced', 'raw', 'multi-ccy-db-1', 'test')
        `);
        await tx.execute(sql`
          INSERT INTO finance.journal_lines (id, entry_id, account_id, currency, debit_minor, credit_minor)
          VALUES
            (${line1Id}::uuid, ${entryId}::uuid, ${acctId('psp_clearing_vnd')}::uuid, 'VND', 1000, 0),
            (${line2Id}::uuid, ${entryId}::uuid, ${acctId('customer_deposits_usd')}::uuid, 'USD', 0, 1000)
        `);
      }),
      /unbalanced/i,
    );
  });

  it('AC4: Line currency != account currency is rejected (app & DB)', async () => {
    // 1. App-level rejection
    await expect(
      db.transaction((tx) =>
        ledger.post(tx, {
          effectiveDate: '2026-11-25',
          description: 'Mismatched line currency',
          sourceType: 'test',
          sourceId: 'ccy-mismatch-app-1',
          entryKind: 'test',
          lines: [
            {
              accountId: acctId('psp_clearing_vnd'),
              side: 'debit',
              amount: createMoney(500n, 'USD'),
            },
            {
              accountId: acctId('customer_deposits_usd'),
              side: 'credit',
              amount: createMoney(500n, 'USD'),
            },
          ],
        }),
      ),
    ).rejects.toThrow(LedgerCurrencyMismatchError);

    // 2. DB-level rejection via raw SQL
    const entryId = '019a0000-0000-7000-8000-000000000021';
    const line1Id = '019a0000-0000-7000-8000-000000000022';

    await expectPgError(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO finance.journal_entries (id, effective_date, description, source_type, source_id, entry_kind)
          VALUES (${entryId}::uuid, '2026-11-25', 'Raw ccy mismatch', 'raw', 'ccy-mismatch-db-1', 'test')
        `);
        await tx.execute(sql`
          INSERT INTO finance.journal_lines (id, entry_id, account_id, currency, debit_minor, credit_minor)
          VALUES (${line1Id}::uuid, ${entryId}::uuid, ${acctId('psp_clearing_vnd')}::uuid, 'USD', 500, 0)
        `);
      }),
      /does not match account/i,
    );
  });

  it('AC5: UPDATE and DELETE on journal_entries and journal_lines via raw SQL are rejected', async () => {
    const posted = await db.transaction((tx) =>
      ledger.post(tx, {
        effectiveDate: '2026-11-25',
        description: 'Immutable entry',
        sourceType: 'test',
        sourceId: 'immut-1',
        entryKind: 'capture',
        lines: [
          {
            accountId: acctId('psp_fees_usd'),
            side: 'debit',
            amount: createMoney(250n, 'USD'),
          },
          {
            accountId: acctId('psp_clearing_usd'),
            side: 'credit',
            amount: createMoney(250n, 'USD'),
          },
        ],
      }),
    );

    const entryId = posted.entry.id;
    const lineId = posted.lines[0]!.id;

    await expectPgError(
      db.execute(sql`
        UPDATE finance.journal_entries SET description = 'tampered' WHERE id = ${entryId}::uuid
      `),
      /immutable/i,
    );

    await expectPgError(
      db.execute(sql`
        DELETE FROM finance.journal_entries WHERE id = ${entryId}::uuid
      `),
      /immutable/i,
    );

    await expectPgError(
      db.execute(sql`
        UPDATE finance.journal_lines SET memo = 'tampered' WHERE id = ${lineId}::uuid
      `),
      /immutable/i,
    );

    await expectPgError(
      db.execute(sql`
        DELETE FROM finance.journal_lines WHERE id = ${lineId}::uuid
      `),
      /immutable/i,
    );
  });

  it('AC6: Reverse restores prior balances, double reverse is rejected, reversing a reversal is allowed', async () => {
    const beforeClearing = await ledger.balance(acctId('psp_clearing_vnd'));
    const beforeFees = await ledger.balance(acctId('psp_fees_vnd'));

    const original = await db.transaction((tx) =>
      ledger.post(tx, {
        effectiveDate: '2026-11-25',
        description: 'VND PSP fee charge',
        sourceType: 'psp_fee',
        sourceId: 'fee-vnd-001',
        entryKind: 'charge',
        lines: [
          {
            accountId: acctId('psp_fees_vnd'),
            side: 'debit',
            amount: createMoney(50_000n, 'VND'),
          },
          {
            accountId: acctId('psp_clearing_vnd'),
            side: 'credit',
            amount: createMoney(50_000n, 'VND'),
          },
        ],
      }),
    );

    expect(await ledger.balance(acctId('psp_fees_vnd'))).toEqual(
      createMoney(beforeFees.amountMinor + 50_000n, 'VND'),
    );
    expect(await ledger.balance(acctId('psp_clearing_vnd'))).toEqual(
      createMoney(beforeClearing.amountMinor - 50_000n, 'VND'),
    );

    // Reverse original -> net balances return to prior values
    const reversal = await db.transaction((tx) =>
      ledger.reverse(tx, original.entry.id, 'Fee waived'),
    );
    expect(reversal.entry.entryKind).toBe('reversal');
    expect(reversal.entry.reversesEntryId).toBe(original.entry.id);

    expect(await ledger.balance(acctId('psp_fees_vnd'))).toEqual(beforeFees);
    expect(await ledger.balance(acctId('psp_clearing_vnd'))).toEqual(beforeClearing);

    // Reversing the same entry twice -> rejected
    await expect(
      db.transaction((tx) => ledger.reverse(tx, original.entry.id, 'Duplicate reversal')),
    ).rejects.toThrow(LedgerAlreadyReversedError);

    // Reversing a reversal IS allowed -> restores the original charge impact
    const reReversal = await db.transaction((tx) =>
      ledger.reverse(tx, reversal.entry.id, 'Fee reinstated'),
    );
    expect(reReversal.entry.entryKind).toBe('reversal');
    expect(reReversal.entry.reversesEntryId).toBe(reversal.entry.id);
    expect(await ledger.balance(acctId('psp_fees_vnd'))).toEqual(
      createMoney(beforeFees.amountMinor + 50_000n, 'VND'),
    );
  });

  it('AC7: Idempotency under concurrency - 10 parallel posts create 1 entry; different lines throw LedgerConflictError', async () => {
    const beforeClearing = await ledger.balance(acctId('psp_clearing_usd'));

    const sharedInput = {
      effectiveDate: '2026-11-25',
      description: 'Concurrent idempotent USD deposit',
      sourceType: 'payment',
      sourceId: 'pay-concurrent-001',
      entryKind: 'capture',
      lines: [
        {
          accountId: acctId('psp_clearing_usd'),
          side: 'debit' as const,
          amount: createMoney(7_700n, 'USD'),
        },
        {
          accountId: acctId('customer_deposits_usd'),
          side: 'credit' as const,
          amount: createMoney(7_700n, 'USD'),
        },
      ],
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.transaction((tx) => ledger.post(tx, sharedInput))),
    );

    const uniqueIds = new Set(results.map((r) => r.entry.id));
    expect(uniqueIds.size).toBe(1);
    const freshCreates = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);
    expect(freshCreates).toHaveLength(1);
    expect(replays).toHaveLength(9);

    // Balance incremented only once
    expect(await ledger.balance(acctId('psp_clearing_usd'))).toEqual(
      createMoney(beforeClearing.amountMinor + 7_700n, 'USD'),
    );

    // Verify 2 journal lines in DB for this entry
    const [entryId] = Array.from(uniqueIds);
    const dbLines = await db
      .select()
      .from(financeJournalLines)
      .where(eq(financeJournalLines.entryId, entryId!));
    expect(dbLines).toHaveLength(2);

    // Same source key with DIFFERENT lines -> LedgerConflictError
    await expect(
      db.transaction((tx) =>
        ledger.post(tx, {
          ...sharedInput,
          lines: [
            {
              accountId: acctId('psp_clearing_usd'),
              side: 'debit',
              amount: createMoney(9_999n, 'USD'),
            },
            {
              accountId: acctId('customer_deposits_usd'),
              side: 'credit',
              amount: createMoney(9_999n, 'USD'),
            },
          ],
        }),
      ),
    ).rejects.toThrow(LedgerConflictError);
  });
});
