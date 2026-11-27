import { sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { outboxEvents } from './platform.ts';

export const notificationsSchema = pgSchema('notifications');

export const EMAIL_TEMPLATES = [
  'booking_held',
  'booking_confirmed',
  'booking_expired',
  'booking_cancelled',
  'refund_succeeded',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export const EMAIL_MESSAGE_STATUSES = ['queued', 'sent', 'failed', 'dead'] as const;
export type EmailMessageStatus = (typeof EMAIL_MESSAGE_STATUSES)[number];

export const notificationsEmailMessages = notificationsSchema.table(
  'email_messages',
  {
    id: id('id'),
    eventId: uuid('event_id')
      .notNull()
      .references(() => outboxEvents.id, { onDelete: 'cascade' }),
    template: text('template').notNull(),
    recipientHash: char('recipient_hash', { length: 64 }).notNull(),
    locale: text('locale').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (table) => [
    unique('email_messages_event_template_unique').on(table.eventId, table.template),
    check('email_messages_status_check', sql`status IN ('queued', 'sent', 'failed', 'dead')`),
    check(
      'email_messages_template_check',
      sql`template IN ('booking_held', 'booking_confirmed', 'booking_expired', 'booking_cancelled', 'refund_succeeded')`,
    ),
    check('email_messages_recipient_hash_check', sql`recipient_hash ~ '^[0-9a-f]{64}$'`),
    check('email_messages_attempts_non_negative_check', sql`attempts >= 0`),
    check('email_messages_version_positive_check', sql`version > 0`),
    check(
      'email_messages_sent_at_consistency_check',
      sql`(status = 'sent' AND sent_at IS NOT NULL) OR (status <> 'sent' AND sent_at IS NULL)`,
    ),
    index('email_messages_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
  ],
);

export type EmailMessageRow = typeof notificationsEmailMessages.$inferSelect;
export type NewEmailMessageRow = typeof notificationsEmailMessages.$inferInsert;
