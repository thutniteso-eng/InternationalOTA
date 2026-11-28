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

export const MOCK_PSP_REFUND_MODES = ['auto_succeed', 'auto_fail', 'delay'] as const;
export type MockPspRefundMode = (typeof MOCK_PSP_REFUND_MODES)[number];

export const REFUND_REASONS = [
  'customer_cancellation',
  'departure_cancelled',
  'supplier_rejected',
  'late_payment',
  'double_payment',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_STATUSES = [
  'requested',
  'processing',
  'succeeded',
  'failed',
  'manual_review',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

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
    refundMode: text('refund_mode').notNull().default('auto_succeed'),
    lastEventId: text('last_event_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (table) => [
    unique('mock_psp_transactions_provider_ref_unique').on(table.providerRef),
    unique('mock_psp_transactions_attempt_unique').on(table.attemptId),
    check('mock_psp_transactions_amount_positive', sql`amount_minor > 0`),
    check('mock_psp_transactions_status_check', sql`status IN ('pending', 'succeeded', 'failed')`),
    check(
      'mock_psp_transactions_refund_mode_check',
      sql`refund_mode IN ('auto_succeed', 'auto_fail', 'delay')`,
    ),
  ],
);

export const paymentsRefunds = paymentsSchema.table(
  'refunds',
  {
    id: id('id'),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookingBookings.id),
    paymentAttemptId: uuid('payment_attempt_id')
      .notNull()
      .references(() => paymentsPaymentAttempts.id),
    provider: text('provider').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('requested'),
    providerRefundRef: text('provider_refund_ref'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lastError: text('last_error'),
    version: integer('version').notNull().default(1),
    ...timestamps(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('refunds_provider_ref_unique').on(table.provider, table.providerRefundRef),
    index('refunds_booking_idx').on(table.bookingId, table.createdAt),
    index('refunds_attempt_idx').on(table.paymentAttemptId),
    index('refunds_executor_idx').on(table.status, table.nextAttemptAt),
    check('refunds_amount_positive', sql`amount_minor > 0`),
    check(
      'refunds_reason_check',
      sql`reason IN ('customer_cancellation', 'departure_cancelled', 'supplier_rejected', 'late_payment', 'double_payment')`,
    ),
    check(
      'refunds_status_check',
      sql`status IN ('requested', 'processing', 'succeeded', 'failed', 'manual_review')`,
    ),
    check('refunds_attempts_non_negative', sql`attempts >= 0`),
    check('refunds_version_check', sql`version > 0`),
    check(
      'refunds_completed_consistency_check',
      sql`(status = 'succeeded' AND completed_at IS NOT NULL) OR (status <> 'succeeded' AND completed_at IS NULL)`,
    ),
  ],
);

export const paymentsMockPspRefunds = paymentsSchema.table(
  'mock_psp_refunds',
  {
    id: id('id'),
    providerRefundRef: text('provider_refund_ref').notNull(),
    refundId: uuid('refund_id').notNull(),
    providerRef: text('provider_ref').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    status: text('status').notNull().default('pending'),
    lastEventId: text('last_event_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (table) => [
    unique('mock_psp_refunds_provider_ref_unique').on(table.providerRefundRef),
    unique('mock_psp_refunds_refund_id_unique').on(table.refundId),
    check('mock_psp_refunds_amount_positive', sql`amount_minor > 0`),
    check('mock_psp_refunds_status_check', sql`status IN ('pending', 'succeeded', 'failed')`),
  ],
);

export type PaymentAttemptRow = typeof paymentsPaymentAttempts.$inferSelect;
export type NewPaymentAttemptRow = typeof paymentsPaymentAttempts.$inferInsert;
export type MockPspTransactionRow = typeof paymentsMockPspTransactions.$inferSelect;
export type NewMockPspTransactionRow = typeof paymentsMockPspTransactions.$inferInsert;
export type RefundRow = typeof paymentsRefunds.$inferSelect;
export type NewRefundRow = typeof paymentsRefunds.$inferInsert;
export type MockPspRefundRow = typeof paymentsMockPspRefunds.$inferSelect;
export type NewMockPspRefundRow = typeof paymentsMockPspRefunds.$inferInsert;
