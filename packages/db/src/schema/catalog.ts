import { sql } from 'drizzle-orm';
import {
  char,
  check,
  customType,
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
import { id, timestamps } from '../columns.ts';
import { countries, languages } from './reference.ts';
import { supplySuppliers } from './supply.ts';

export const catalogSchema = pgSchema('catalog');

export const PRODUCT_KINDS = ['tour', 'activity', 'transfer'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_PRODUCT_IMAGES = 20;

export const geographyPoint = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'geography(Point,4326)';
  },
});

export const catalogProducts = catalogSchema.table(
  'products',
  {
    id: id('id'),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplySuppliers.id),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('draft'),
    countryAlpha2: char('country_alpha2', { length: 2 })
      .notNull()
      .references(() => countries.alpha2),
    region: text('region').notNull(),
    location: geographyPoint('location'),
    meetingPointNote: text('meeting_point_note'),
    timeZone: text('time_zone').notNull().default('Asia/Ho_Chi_Minh'),
    durationMinutes: integer('duration_minutes'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    check('products_kind_check', sql`kind IN ('tour', 'activity', 'transfer')`),
    check('products_status_check', sql`status IN ('draft', 'published', 'archived')`),
    check('products_duration_minutes_check', sql`duration_minutes IS NULL OR duration_minutes > 0`),
    check('products_time_zone_non_empty_check', sql`length(trim(time_zone)) > 0`),
    check('products_published_location_check', sql`status <> 'published' OR location IS NOT NULL`),
    index('products_published_listing_idx').on(table.status, table.publishedAt, table.id),
    index('products_supplier_idx').on(table.supplierId),
  ],
);

export const catalogProductTranslations = catalogSchema.table(
  'product_translations',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    locale: text('locale')
      .notNull()
      .references(() => languages.tag),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    summary: text('summary').notNull(),
    description: text('description').notNull(),
    highlights: jsonb('highlights').$type<string[]>().notNull().default([]),
    inclusions: jsonb('inclusions').$type<string[]>().notNull().default([]),
    exclusions: jsonb('exclusions').$type<string[]>().notNull().default([]),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.locale] }),
    unique('product_translations_locale_slug_unique').on(table.locale, table.slug),
    check('product_translations_slug_format_check', sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'product_translations_arrays_check',
      sql`jsonb_typeof(highlights) = 'array' AND jsonb_typeof(inclusions) = 'array' AND jsonb_typeof(exclusions) = 'array'`,
    ),
  ],
);

export const catalogProductImages = catalogSchema.table(
  'product_images',
  {
    id: id('id'),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    sort: smallint('sort').notNull().default(0),
    alt: jsonb('alt').$type<Record<string, string>>().notNull(),
  },
  (table) => [
    check('product_images_https_url_check', sql`url ~ '^https://'`),
    check('product_images_sort_check', sql`sort >= 0 AND sort < 20`),
    check('product_images_alt_object_check', sql`jsonb_typeof(alt) = 'object'`),
    index('product_images_product_sort_idx').on(table.productId, table.sort),
  ],
);

export type CatalogProduct = typeof catalogProducts.$inferSelect;
export type NewCatalogProduct = typeof catalogProducts.$inferInsert;
export type CatalogProductTranslation = typeof catalogProductTranslations.$inferSelect;
export type NewCatalogProductTranslation = typeof catalogProductTranslations.$inferInsert;
export type CatalogProductImage = typeof catalogProductImages.$inferSelect;
export type NewCatalogProductImage = typeof catalogProductImages.$inferInsert;
