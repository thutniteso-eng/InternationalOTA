import { jsonb, pgSchema, text } from 'drizzle-orm/pg-core';
import { timestamps } from '../columns.ts';

export const platformSchema = pgSchema('platform');

export const appMeta = platformSchema.table('app_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  ...timestamps(),
});

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;
