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
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { catalogProducts } from './catalog.ts';
import { identityUsers } from './identity.ts';
import { inventoryDepartures } from './inventory.ts';
import { currencies } from './reference.ts';

export const bookingSchema = pgSchema('booking');

export const BOOKING_STATUSES = [
  'held',
  'payment_pending',
  'confirmed',
  'expired',
  'cancelled',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const ACTIVE_HOLD_STATUSES: readonly BookingStatus[] = ['held', 'payment_pending'];
export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'expired',
  'cancelled',
];

export interface BookingPaxJson {
  readonly adult: number;
  readonly child: number;
  readonly infant: number;
}

export const bookingBookings = bookingSchema.table(
  'bookings',
  {
    id: id('id'),
    reference: text('reference').notNull(),
    customerUserId: text('customer_user_id')
      .notNull()
      .references(() => identityUsers.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    departureId: uuid('departure_id')
      .notNull()
      .references(() => inventoryDepartures.id),
    status: text('status').notNull().default('held'),
    pax: jsonb('pax').$type<BookingPaxJson>().notNull(),
    seats: integer('seats').notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    totalAmountMinor: bigint('total_amount_minor', { mode: 'bigint' }).notNull(),
    quoteSnapshot: jsonb('quote_snapshot').$type<Record<string, unknown>>().notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    contactName: text('contact_name').notNull(),
    contactEmail: text('contact_email').notNull(),
    contactPhone: text('contact_phone').notNull(),
    contactLocale: text('contact_locale').notNull(),
    allocationRef: text('allocation_ref').notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }).notNull(),
    paymentRef: text('payment_ref'),
    version: integer('version').notNull().default(1),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    unique('bookings_reference_unique').on(table.reference),
    index('bookings_due_expiry_idx')
      .on(table.status, table.holdExpiresAt)
      .where(sql`status IN ('held', 'payment_pending')`),
    index('bookings_customer_created_idx').on(table.customerUserId, table.createdAt.desc()),
    index('bookings_departure_idx').on(table.departureId),
    check(
      'bookings_status_check',
      sql`status IN ('held', 'payment_pending', 'confirmed', 'expired', 'cancelled')`,
    ),
    check('bookings_seats_check', sql`seats > 0`),
    check('bookings_total_amount_check', sql`total_amount_minor >= 0`),
    check('bookings_version_check', sql`version > 0`),
    check(
      'bookings_confirmed_consistency_check',
      sql`status <> 'confirmed' OR (payment_ref IS NOT NULL AND confirmed_at IS NOT NULL)`,
    ),
    check('bookings_expired_consistency_check', sql`status <> 'expired' OR expired_at IS NOT NULL`),
    check(
      'bookings_cancelled_consistency_check',
      sql`status <> 'cancelled' OR cancelled_at IS NOT NULL`,
    ),
  ],
);

export const bookingEvents = bookingSchema.table(
  'booking_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookingBookings.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('booking_events_booking_at_idx').on(table.bookingId, table.at),
    check(
      'booking_events_from_status_check',
      sql`from_status IS NULL OR from_status IN ('held', 'payment_pending', 'confirmed', 'expired', 'cancelled')`,
    ),
    check(
      'booking_events_to_status_check',
      sql`to_status IN ('held', 'payment_pending', 'confirmed', 'expired', 'cancelled')`,
    ),
  ],
);

export type BookingRow = typeof bookingBookings.$inferSelect;
export type BookingEventRow = typeof bookingEvents.$inferSelect;
