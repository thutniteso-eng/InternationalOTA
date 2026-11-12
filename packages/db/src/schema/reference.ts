import { boolean, char, pgSchema, smallint, text } from 'drizzle-orm/pg-core';
import { timestamps } from '../columns.ts';

export const referenceSchema = pgSchema('reference');

export const countries = referenceSchema.table('countries', {
  alpha2: char('alpha2', { length: 2 }).primaryKey(),
  alpha3: char('alpha3', { length: 3 }).notNull().unique(),
  numeric: char('numeric', { length: 3 }).notNull().unique(),
  nameEn: text('name_en').notNull(),
  ...timestamps(),
});

export const currencies = referenceSchema.table('currencies', {
  code: char('code', { length: 3 }).primaryKey(),
  numeric: char('numeric', { length: 3 }),
  minorUnits: smallint('minor_units'),
  nameEn: text('name_en').notNull(),
  enabledForSale: boolean('enabled_for_sale').notNull().default(false),
  ...timestamps(),
});

export const languages = referenceSchema.table('languages', {
  tag: text('tag').primaryKey(),
  nameEn: text('name_en').notNull(),
  nameNative: text('name_native').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  ...timestamps(),
});

export const timeZones = referenceSchema.table('time_zones', {
  name: text('name').primaryKey(),
  countryAlpha2: char('country_alpha2', { length: 2 }).references(() => countries.alpha2),
  ...timestamps(),
});
