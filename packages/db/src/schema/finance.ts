import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { currencies } from './reference.ts';

export const financeSchema = pgSchema('finance');

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const financeAccounts = financeSchema.table(
  'accounts',
  {
    id: id('id'),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  () => [
    check(
      'accounts_type_check',
      sql`type IN ('asset', 'liability', 'equity', 'revenue', 'expense')`,
    ),
  ],
);

export const financeJournalEntries = financeSchema.table(
  'journal_entries',
  {
    id: id('id'),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    description: text('description').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    entryKind: text('entry_kind').notNull(),
    reversesEntryId: uuid('reverses_entry_id').references(
      (): AnyPgColumn => financeJournalEntries.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('journal_entries_source_unique').on(table.sourceType, table.sourceId, table.entryKind),
    unique('journal_entries_reverses_unique').on(table.reversesEntryId),
  ],
);

export const financeJournalLines = financeSchema.table(
  'journal_lines',
  {
    id: id('id'),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => financeJournalEntries.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financeAccounts.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    debitMinor: bigint('debit_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditMinor: bigint('credit_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    memo: text('memo'),
  },
  (table) => [
    check('journal_lines_debit_non_negative', sql`debit_minor >= 0`),
    check('journal_lines_credit_non_negative', sql`credit_minor >= 0`),
    check('journal_lines_one_side_positive', sql`(debit_minor > 0) <> (credit_minor > 0)`),
    index('journal_lines_entry_id_idx').on(table.entryId),
    index('journal_lines_account_id_idx').on(table.accountId),
  ],
);

export type FinanceAccount = typeof financeAccounts.$inferSelect;
export type NewFinanceAccount = typeof financeAccounts.$inferInsert;
export type FinanceJournalEntry = typeof financeJournalEntries.$inferSelect;
export type NewFinanceJournalEntry = typeof financeJournalEntries.$inferInsert;
export type FinanceJournalLine = typeof financeJournalLines.$inferSelect;
export type NewFinanceJournalLine = typeof financeJournalLines.$inferInsert;
