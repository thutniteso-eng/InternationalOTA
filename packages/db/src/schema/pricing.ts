import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from '../columns.ts';
import { catalogProducts } from './catalog.ts';
import { currencies } from './reference.ts';

export const pricingSchema = pgSchema('pricing');

export const PAX_TYPES = ['adult', 'child', 'infant'] as const;
export type PaxType = (typeof PAX_TYPES)[number];

export interface CancellationRuleRecord {
  readonly hoursBeforeStart: number;
  readonly refundPercent: number;
}

export const pricingPriceLists = pricingSchema.table(
  'price_lists',
  {
    id: id('id'),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    version: integer('version').notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    createdBy: text('created_by').notNull(),
    createdTxid: bigint('created_txid', { mode: 'bigint' })
      .notNull()
      .default(sql`txid_current()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('price_lists_product_version_unique').on(table.productId, table.version),
    index('price_lists_product_dates_idx').on(table.productId, table.validFrom, table.validTo),
    check('price_lists_version_check', sql`version > 0`),
    check('price_lists_valid_range_check', sql`valid_to IS NULL OR valid_to >= valid_from`),
  ],
);

export const pricingPriceListItems = pricingSchema.table(
  'price_list_items',
  {
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => pricingPriceLists.id),
    paxType: text('pax_type').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    minAge: smallint('min_age').notNull(),
    maxAge: smallint('max_age'),
    occupiesSeat: boolean('occupies_seat').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.priceListId, table.paxType] }),
    check('price_list_items_pax_type_check', sql`pax_type IN ('adult', 'child', 'infant')`),
    check('price_list_items_amount_check', sql`amount_minor >= 0`),
    check(
      'price_list_items_age_check',
      sql`min_age >= 0 AND (max_age IS NULL OR max_age >= min_age)`,
    ),
  ],
);

export const pricingCancellationPolicies = pricingSchema.table(
  'cancellation_policies',
  {
    id: id('id'),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    version: integer('version').notNull(),
    rules: jsonb('rules').$type<CancellationRuleRecord[]>().notNull(),
    weatherClause: text('weather_clause'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('cancellation_policies_product_version_unique').on(table.productId, table.version),
    check('cancellation_policies_version_check', sql`version > 0`),
    check('cancellation_policies_rules_array_check', sql`jsonb_typeof(rules) = 'array'`),
  ],
);

export type PricingPriceListRow = typeof pricingPriceLists.$inferSelect;
export type PricingPriceListItemRow = typeof pricingPriceListItems.$inferSelect;
export type PricingCancellationPolicyRow = typeof pricingCancellationPolicies.$inferSelect;
