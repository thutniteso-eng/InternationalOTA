import type { FinanceJournalEntry, FinanceJournalLine } from '@internationalota/db';
import type { Money } from '@internationalota/money';
import type { LocalDate } from '@internationalota/time';

export type LedgerSide = 'debit' | 'credit';

export interface PostJournalLineInput {
  accountId: string;
  side: LedgerSide;
  amount: Money;
  memo?: string;
}

export interface PostJournalEntryInput {
  effectiveDate: LocalDate;
  description: string;
  sourceType: string;
  sourceId: string;
  entryKind: string;
  reversesEntryId?: string | null;
  lines: readonly PostJournalLineInput[];
}

export interface PostedJournalEntry {
  entry: FinanceJournalEntry;
  lines: FinanceJournalLine[];
  idempotentReplay: boolean;
}

export interface BalanceQueryOptions {
  asOf?: LocalDate;
}
