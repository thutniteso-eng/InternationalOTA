import { sql } from 'drizzle-orm';
import {
  char,
  check,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { timestamps } from '../columns.ts';

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

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
