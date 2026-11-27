import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { bookingBookings } from './booking.ts';
import { currencies } from './reference.ts';

export const paymentsSchema = pgSchema('payments');

export const PAYMENT_ATTEMPT_STATUSES = [
  'initiated',
  'succeeded',
  'failed',
  'refund_required',
  'expired',
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export const PAYMENT_ATTEMPT_TERMINAL_STATUSES: readonly PaymentAttemptStatus[] = [
  'succeeded',
  'failed',
  'refund_required',
  'expired',
];

export const MOCK_PSP_TRANSACTION_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type MockPspTransactionStatus = (typeof MOCK_PSP_TRANSACTION_STATUSES)[number];

export const paymentsPaymentAttempts = paymentsSchema.table(
  'payment_attempts',
  {
    id: id('id'),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookingBookings.id),
    provider: text('provider').notNull(),
    providerRef: text('provider_ref'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    providerConfigSnapshot: jsonb('provider_config_snapshot')
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text('status').notNull().default('initiated'),
    failureReason: text('failure_reason'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('payment_attempts_provider_ref_unique').on(table.provider, table.providerRef),
    uniqueIndex('payment_attempts_one_succeeded_per_booking_idx')
      .on(table.bookingId)
      .where(sql`status = 'succeeded'`),
    index('payment_attempts_booking_created_idx').on(table.bookingId, table.createdAt),
    index('payment_attempts_status_created_idx').on(table.status, table.createdAt),
    check('payment_attempts_amount_positive', sql`amount_minor > 0`),
    check(
      'payment_attempts_status_check',
      sql`status IN ('initiated', 'succeeded', 'failed', 'refund_required', 'expired')`,
    ),
    check('payment_attempts_version_check', sql`version > 0`),
    check(
      'payment_attempts_completed_consistency_check',
      sql`(status = 'initiated' AND completed_at IS NULL) OR (status <> 'initiated' AND completed_at IS NOT NULL)`,
    ),
  ],
);

export const paymentsMockPspTransactions = paymentsSchema.table(
  'mock_psp_transactions',
  {
    id: id('id'),
    providerRef: text('provider_ref').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    bookingReference: text('booking_reference').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    locale: text('locale').notNull(),
    returnUrl: text('return_url').notNull(),
    status: text('status').notNull().default('pending'),
    lastEventId: text('last_event_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (table) => [
    unique('mock_psp_transactions_provider_ref_unique').on(table.providerRef),
    unique('mock_psp_transactions_attempt_unique').on(table.attemptId),
    check('mock_psp_transactions_amount_positive', sql`amount_minor > 0`),
    check('mock_psp_transactions_status_check', sql`status IN ('pending', 'succeeded', 'failed')`),
  ],
);

export type PaymentAttemptRow = typeof paymentsPaymentAttempts.$inferSelect;
export type NewPaymentAttemptRow = typeof paymentsPaymentAttempts.$inferInsert;
export type MockPspTransactionRow = typeof paymentsMockPspTransactions.$inferSelect;
export type NewMockPspTransactionRow = typeof paymentsMockPspTransactions.$inferInsert;
