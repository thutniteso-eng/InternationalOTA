import { sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';

export const platformSchema = pgSchema('platform');

export const appMeta = platformSchema.table('app_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  ...timestamps(),
});

export const idempotencyKeys = platformSchema.table(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    state: text('state').notNull(),
    responseStatus: smallint('response_status'),
    responseBody: jsonb('response_body'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key] }),
    check('idempotency_keys_state_check', sql`state IN ('in_progress', 'completed')`),
  ],
);

export const outboxEvents = platformSchema.table(
  'outbox_events',
  {
    id: id('id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
  },
  (table) => [
    index('outbox_events_pending_idx')
      .on(table.nextAttemptAt, table.occurredAt)
      .where(sql`published_at IS NULL AND dead_lettered_at IS NULL`),
  ],
);

export const inboxMessages = platformSchema.table(
  'inbox_messages',
  {
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    rawBody: text('raw_body').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerEventId] }),
    index('inbox_messages_pending_idx')
      .on(table.nextAttemptAt, table.receivedAt)
      .where(sql`processed_at IS NULL AND dead_lettered_at IS NULL`),
  ],
);

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type InboxMessage = typeof inboxMessages.$inferSelect;
export type NewInboxMessage = typeof inboxMessages.$inferInsert;
