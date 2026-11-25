import { sql } from 'drizzle-orm';
import { char, check, pgSchema, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { countries } from './reference.ts';

export const supplySchema = pgSchema('supply');

export const SUPPLIER_STATUSES = ['active', 'suspended'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const supplySuppliers = supplySchema.table(
  'suppliers',
  {
    id: id('id'),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    countryAlpha2: char('country_alpha2', { length: 2 })
      .notNull()
      .references(() => countries.alpha2),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  () => [check('suppliers_status_check', sql`status IN ('active', 'suspended')`)],
);

export type SupplySupplier = typeof supplySuppliers.$inferSelect;
export type NewSupplySupplier = typeof supplySuppliers.$inferInsert;
