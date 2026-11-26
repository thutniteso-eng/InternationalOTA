import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgSchema,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { catalogProducts } from './catalog.ts';

export const inventorySchema = pgSchema('inventory');

export const DEPARTURE_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type DepartureStatus = (typeof DEPARTURE_STATUSES)[number];

export const ALLOCATION_STATES = ['active', 'released'] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

export const inventoryDepartures = inventorySchema.table(
  'departures',
  {
    id: id('id'),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    localTime: time('local_time').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    capacity: integer('capacity').notNull(),
    allocated: integer('allocated').notNull().default(0),
    status: text('status').notNull().default('open'),
    bookingCutoffMinutes: integer('booking_cutoff_minutes').notNull().default(60),
    ...timestamps(),
  },
  (table) => [
    unique('departures_product_starts_at_unique').on(table.productId, table.startsAt),
    index('departures_product_local_date_idx').on(
      table.productId,
      table.localDate,
      table.localTime,
    ),
    check('departures_capacity_check', sql`capacity > 0`),
    check('departures_allocated_check', sql`allocated >= 0 AND allocated <= capacity`),
    check('departures_status_check', sql`status IN ('open', 'closed', 'cancelled')`),
    check('departures_cutoff_check', sql`booking_cutoff_minutes >= 0`),
  ],
);

export const inventoryAllocations = inventorySchema.table(
  'allocations',
  {
    id: id('id'),
    departureId: uuid('departure_id')
      .notNull()
      .references(() => inventoryDepartures.id),
    quantity: integer('quantity').notNull(),
    refType: text('ref_type').notNull(),
    refId: text('ref_id').notNull(),
    state: text('state').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => [
    unique('allocations_departure_ref_unique').on(table.departureId, table.refType, table.refId),
    index('allocations_departure_state_idx').on(table.departureId, table.state),
    check('allocations_quantity_check', sql`quantity > 0`),
    check('allocations_ref_type_non_empty_check', sql`length(trim(ref_type)) > 0`),
    check('allocations_ref_id_non_empty_check', sql`length(trim(ref_id)) > 0`),
    check('allocations_state_check', sql`state IN ('active', 'released')`),
    check(
      'allocations_released_at_consistency_check',
      sql`(state = 'active' AND released_at IS NULL) OR (state = 'released' AND released_at IS NOT NULL)`,
    ),
  ],
);

export type InventoryDepartureRow = typeof inventoryDepartures.$inferSelect;
export type InventoryAllocationRow = typeof inventoryAllocations.$inferSelect;
