import {
  and,
  type BookingEventRow,
  bookingBookings,
  bookingEvents,
  type BookingRow,
  type BookingStatus,
  type DatabaseClient,
  type DatabaseTransaction,
  desc,
  eq,
  gte,
  lte,
  sql,
  uuidv7,
} from '@internationalota/db';
import { formatMoney } from '@internationalota/i18n';
import { assertSupportedCurrency, createMoney } from '@internationalota/money';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LocaleService } from '../../common/i18n/locale.service.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { IdentityService } from '../identity/index.js';
import { InventoryService } from '../inventory/index.js';
import { type BookingExpiryWorkerPort, OutboxService } from '../messaging/index.js';
import {
  isSameQuote,
  PricingService,
  type PublicQuoteLineDto,
  type PublicQuoteResponse,
  type QuoteSnapshot,
} from '../pricing/index.js';
import {
  bookingConflictException,
  bookingCutoffPassedException,
  bookingDepartureClosedException,
  bookingDepartureNotFoundException,
  bookingEmailNotVerifiedException,
  bookingInvalidQueryException,
  bookingNotCancellableException,
  bookingNotFoundException,
  bookingPriceChangedException,
  bookingSoldOutException,
  bookingTooManyActiveHoldsException,
  bookingValidationException,
} from './booking.errors.js';
import { generateBookingReference, normalizeBookingReference } from './booking.reference.js';
import {
  BOOKING_PAYMENT_SUMMARY_PORT,
  CONFIRMED_BOOKING_CANCELLATION_PORT,
  type AdminBookingListQuery,
  type BookingDetailDto,
  type BookingEventDto,
  type BookingExpiryResult,
  type BookingPaymentSummaryDto,
  type BookingPaymentSummaryPort,
  type BookingRefundSummaryDto,
  type CancelBookingResult,
  type ConfirmedBookingCancellationPort,
  type ConfirmedCancelResponseDto,
  type ConfirmBookingResult,
  type CreateHoldInput,
  type CreateHoldResult,
  type CustomerBookingListResponse,
  type HoldBookingResponseDto,
  type MarkPaymentPendingResult,
} from './booking.types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_BOOKING_HOLD_MINUTES = 15;
const MIN_BOOKING_HOLD_MINUTES = 5;
const MAX_BOOKING_HOLD_MINUTES = 60;
const MAX_ACTIVE_HOLDS_PER_CUSTOMER = 3;
const MAX_REFERENCE_RETRIES = 5;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_EXPIRY_LIMIT = 50;
const MAX_EXPIRY_LIMIT = 500;
const MAX_PAX_TOTAL = 50;

const LEGAL_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  held: ['payment_pending', 'expired', 'cancelled'],
  payment_pending: ['confirmed', 'expired', 'cancelled'],
  confirmed: ['cancelled'],
  expired: [],
  cancelled: [],
};

class HoldTransactionAbortError extends Error {
  constructor(readonly result: CreateHoldResult) {
    super('Hold transaction aborted with typed outcome');
  }
}

export function parseBookingHoldMinutes(raw = process.env['BOOKING_HOLD_MINUTES']): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_BOOKING_HOLD_MINUTES;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid BOOKING_HOLD_MINUTES="${raw}". Expected an integer between ${MIN_BOOKING_HOLD_MINUTES} and ${MAX_BOOKING_HOLD_MINUTES}.`,
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < MIN_BOOKING_HOLD_MINUTES || parsed > MAX_BOOKING_HOLD_MINUTES) {
    throw new Error(
      `Invalid BOOKING_HOLD_MINUTES="${raw}". Allowed range is ${MIN_BOOKING_HOLD_MINUTES}..${MAX_BOOKING_HOLD_MINUTES}.`,
    );
  }
  return parsed;
}

function extractPgField(err: unknown, field: 'code' | 'constraint'): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const rec = err as Record<string, unknown>;
  if (typeof rec[field] === 'string') {
    return rec[field];
  }
  if (typeof rec['cause'] === 'object' && rec['cause'] !== null) {
    const causeVal = (rec['cause'] as Record<string, unknown>)[field];
    if (typeof causeVal === 'string') {
      return causeVal;
    }
  }
  return undefined;
}

interface BookingCursor {
  readonly createdAt: string;
  readonly id: string;
}

function encodeBookingCursor(cursor: BookingCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeBookingCursor(raw: string): BookingCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid');
    }
    const rec = parsed as Record<string, unknown>;
    if (
      typeof rec['createdAt'] !== 'string' ||
      typeof rec['id'] !== 'string' ||
      !UUID_REGEX.test(rec['id'])
    ) {
      throw new Error('invalid');
    }
    return { createdAt: rec['createdAt'], id: rec['id'] };
  } catch {
    throw new BadRequestException({
      message: 'Invalid booking pagination cursor',
      i18nKey: 'booking.query.invalidParams',
      i18nParams: { reason: 'invalid cursor' },
      errorCode: 'booking_invalid_query',
    });
  }
}

function toPublicQuoteResponse(snapshot: QuoteSnapshot, locale: string): PublicQuoteResponse {
  assertSupportedCurrency(snapshot.currency);
  const lines: PublicQuoteLineDto[] = snapshot.lines.map((line) => ({
    paxType: line.paxType,
    quantity: line.quantity,
    unitAmountMinor: line.unitAmountMinor,
    unitFormatted: formatMoney(
      createMoney(BigInt(line.unitAmountMinor), snapshot.currency),
      locale,
    ),
    lineAmountMinor: line.lineAmountMinor,
    lineFormatted: formatMoney(
      createMoney(BigInt(line.lineAmountMinor), snapshot.currency),
      locale,
    ),
  }));

  return {
    productId: snapshot.productId,
    departureId: snapshot.departureId,
    startsAt: snapshot.startsAt,
    localDate: snapshot.localDate,
    locale,
    currency: snapshot.currency,
    lines,
    totalAmountMinor: snapshot.totalAmountMinor,
    totalFormatted: formatMoney(
      createMoney(BigInt(snapshot.totalAmountMinor), snapshot.currency),
      locale,
    ),
    seats: snapshot.seats,
    priceListVersion: snapshot.priceListVersion,
    cancellationPolicyVersion: snapshot.cancellationPolicyVersion,
    rules: snapshot.rules,
    weatherClause: snapshot.weatherClause,
    quotedAt: snapshot.quotedAt,
    snapshotHash: snapshot.snapshotHash,
  };
}

function toBookingEventDto(row: BookingEventRow): BookingEventDto {
  return {
    id: row.id,
    fromStatus: row.fromStatus as BookingStatus | null,
    toStatus: row.toStatus as BookingStatus,
    actor: row.actor,
    reason: row.reason,
    at: row.at.toISOString(),
  };
}

function toBookingDetailDto(
  row: BookingRow,
  events?: readonly BookingEventDto[],
  payment?: BookingPaymentSummaryDto,
  refund?: BookingRefundSummaryDto | null,
): BookingDetailDto {
  return {
    id: row.id,
    reference: row.reference,
    customerUserId: row.customerUserId,
    productId: row.productId,
    departureId: row.departureId,
    status: row.status as BookingStatus,
    pax: row.pax,
    seats: row.seats,
    currency: row.currency.trim(),
    totalAmountMinor: row.totalAmountMinor.toString(),
    quoteSnapshot: row.quoteSnapshot as unknown as QuoteSnapshot,
    snapshotHash: row.snapshotHash,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    contactLocale: row.contactLocale,
    holdExpiresAt: row.holdExpiresAt.toISOString(),
    paymentRef: row.paymentRef,
    version: row.version,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    expiredAt: row.expiredAt ? row.expiredAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(events !== undefined ? { events } : {}),
    ...(payment !== undefined ? { payment } : {}),
    ...(refund ? { refund } : {}),
  };
}

type InternalTransitionOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal'; readonly current: BookingRow }
  | { readonly kind: 'version_conflict'; readonly current: BookingRow }
  | {
      readonly kind: 'transitioned';
      readonly fromStatus: BookingStatus;
      readonly booking: BookingRow;
    };

@Injectable()
export class BookingService implements BookingExpiryWorkerPort, OnModuleInit {
  private readonly logger = new Logger(BookingService.name);
  readonly holdMinutes: number;
  private paymentSummaryPort: BookingPaymentSummaryPort | null = null;
  private confirmedCancellationPort: ConfirmedBookingCancellationPort | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly pricingService: PricingService,
    private readonly inventoryService: InventoryService,
    private readonly outboxService: OutboxService,
    private readonly identityService: IdentityService,
    private readonly localeService: LocaleService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    this.holdMinutes = parseBookingHoldMinutes();
  }

  onModuleInit(): void {
    if (!this.moduleRef) {
      return;
    }
    try {
      this.paymentSummaryPort = this.moduleRef.get<BookingPaymentSummaryPort>(
        BOOKING_PAYMENT_SUMMARY_PORT,
        { strict: false },
      );
    } catch {
      this.paymentSummaryPort = null;
    }
    try {
      this.confirmedCancellationPort = this.moduleRef.get<ConfirmedBookingCancellationPort>(
        CONFIRMED_BOOKING_CANCELLATION_PORT,
        { strict: false },
      );
    } catch {
      this.confirmedCancellationPort = null;
    }
  }

  private withTx<T>(
    tx: DatabaseTransaction | undefined,
    fn: (activeTx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    if (tx) {
      return fn(tx);
    }
    return this.db.transaction(fn);
  }

  /**
   * Single internal transition gate for all `booking.bookings` mutations:
   * - Acquires row-level `FOR UPDATE` lock inside `tx`;
   * - Verifies legal state machine edges in code;
   * - Passes transaction-local actor/reason via `set_config` for the audit trigger;
   * - Performs conditional `UPDATE ... SET status, version = version + 1 WHERE id = $id AND version = $v`
   *   backed by the PostgreSQL `BEFORE UPDATE` trigger.
   */
  private async transitionBooking(
    tx: DatabaseTransaction,
    params: {
      readonly bookingId: string;
      readonly actor: string;
      readonly reason: string;
      readonly expectedFromStatuses?: readonly BookingStatus[];
      readonly targetStatus: BookingStatus;
      readonly paymentRef?: string | null;
      readonly expectedVersion?: number;
      readonly requireNotExpired?: boolean;
    },
  ): Promise<InternalTransitionOutcome> {
    const [locked] = await tx
      .select()
      .from(bookingBookings)
      .where(eq(bookingBookings.id, params.bookingId))
      .for('update');

    if (!locked) {
      return { kind: 'not_found' };
    }

    const currentStatus = locked.status as BookingStatus;
    if (params.expectedFromStatuses && !params.expectedFromStatuses.includes(currentStatus)) {
      return { kind: 'illegal', current: locked };
    }

    const allowedNext = LEGAL_TRANSITIONS[currentStatus];
    if (!allowedNext.includes(params.targetStatus)) {
      return { kind: 'illegal', current: locked };
    }

    if (params.requireNotExpired) {
      const clockRes = await tx.execute(
        sql`SELECT (${locked.holdExpiresAt}::timestamptz > now()) AS "stillValid"`,
      );
      const validRow = clockRes.rows[0];
      if (validRow?.['stillValid'] !== true) {
        return { kind: 'illegal', current: locked };
      }
    }

    await tx.execute(
      sql`SELECT set_config('booking.actor', ${params.actor}, true), set_config('booking.reason', ${params.reason}, true)`,
    );

    const expectedVersion = params.expectedVersion ?? locked.version;

    const [updated] = await tx
      .update(bookingBookings)
      .set({
        status: params.targetStatus,
        version: locked.version + 1,
        updatedAt: sql`now()`,
        ...(params.targetStatus === 'confirmed'
          ? { paymentRef: params.paymentRef!, confirmedAt: sql`now()` }
          : {}),
        ...(params.targetStatus === 'expired' ? { expiredAt: sql`now()` } : {}),
        ...(params.targetStatus === 'cancelled' ? { cancelledAt: sql`now()` } : {}),
      })
      .where(and(eq(bookingBookings.id, locked.id), eq(bookingBookings.version, expectedVersion)))
      .returning();

    if (!updated) {
      return { kind: 'version_conflict', current: locked };
    }

    return {
      kind: 'transitioned',
      fromStatus: currentStatus,
      booking: updated,
    };
  }

  private validateHoldInput(input: CreateHoldInput): {
    departureId: string;
    adult: number;
    child: number;
    infant: number;
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    contactLocale: string;
    expectedSnapshotHash: string;
  } {
    if (!UUID_REGEX.test(input.departureId)) {
      throw bookingValidationException('departureId must be a valid UUID');
    }
    const rawPax: unknown = input.pax;
    if (typeof rawPax !== 'object' || rawPax === null || Array.isArray(rawPax)) {
      throw bookingValidationException('pax must be an object with adult/child/infant counts');
    }
    const adult = input.pax.adult;
    const child = input.pax.child ?? 0;
    const infant = input.pax.infant ?? 0;
    if (
      !Number.isInteger(adult) ||
      !Number.isInteger(child) ||
      !Number.isInteger(infant) ||
      adult < 1 ||
      child < 0 ||
      infant < 0 ||
      adult + child + infant > MAX_PAX_TOTAL
    ) {
      throw bookingValidationException(
        `pax requires adult >= 1, non-negative counts, and total <= ${MAX_PAX_TOTAL}`,
      );
    }

    const rawContact: unknown = input.contact;
    if (typeof rawContact !== 'object' || rawContact === null || Array.isArray(rawContact)) {
      throw bookingValidationException('contact must be an object with name, email, phone');
    }
    const contactName = typeof input.contact.name === 'string' ? input.contact.name.trim() : '';
    const contactEmail = typeof input.contact.email === 'string' ? input.contact.email.trim() : '';
    const contactPhone = typeof input.contact.phone === 'string' ? input.contact.phone.trim() : '';
    if (!contactName || contactName.length > 160) {
      throw bookingValidationException('contact.name is required');
    }
    if (!EMAIL_REGEX.test(contactEmail) || contactEmail.length > 254) {
      throw bookingValidationException('contact.email must be valid');
    }
    if (!contactPhone || contactPhone.length < 6 || contactPhone.length > 40) {
      throw bookingValidationException('contact.phone must be between 6 and 40 characters');
    }

    const expectedSnapshotHash =
      typeof input.expectedSnapshotHash === 'string' ? input.expectedSnapshotHash.trim() : '';
    if (!expectedSnapshotHash) {
      throw bookingValidationException('expectedSnapshotHash is required');
    }

    const contactLocale = this.localeService.resolveLocale(
      input.contact.locale,
      input.acceptLanguage,
    );

    return {
      departureId: input.departureId,
      adult,
      child,
      infant,
      contactName,
      contactEmail,
      contactPhone,
      contactLocale,
      expectedSnapshotHash,
    };
  }

  async createHold(input: CreateHoldInput): Promise<CreateHoldResult> {
    const validated = this.validateHoldInput(input);

    // 1. Re-quote via pricing (READ ONLY)
    const quoteRes = await this.pricingService.quote({
      departureId: validated.departureId,
      pax: {
        adult: validated.adult,
        child: validated.child,
        infant: validated.infant,
      },
    });

    if (!quoteRes.ok) {
      if (quoteRes.code === 'departure_not_found') {
        return { ok: false, reason: 'not_found' };
      }
      throw new UnprocessableEntityException({
        message: quoteRes.message,
        i18nKey: quoteRes.i18nKey,
        ...(quoteRes.i18nParams ? { i18nParams: quoteRes.i18nParams } : {}),
        errorCode: quoteRes.code,
      });
    }

    const snapshot = quoteRes.snapshot;
    if (!isSameQuote(snapshot, { snapshotHash: validated.expectedSnapshotHash })) {
      return {
        ok: false,
        reason: 'price_changed',
        quote: toPublicQuoteResponse(snapshot, validated.contactLocale),
      };
    }

    try {
      const booking = await this.db.transaction(async (tx) => {
        // Check active holds per customer under a customer-scoped advisory lock (anti-hoarding)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('booking_customer_holds'), hashtext(${input.customerUserId}))`,
        );

        const activeCountRes = await tx.execute(sql`
          SELECT COUNT(*)::int AS "activeCount"
          FROM booking.bookings
          WHERE customer_user_id = ${input.customerUserId}
            AND status IN ('held', 'payment_pending')
        `);
        const activeCount = Number(activeCountRes.rows[0]?.['activeCount'] ?? 0);
        if (activeCount >= MAX_ACTIVE_HOLDS_PER_CUSTOMER) {
          throw new HoldTransactionAbortError({ ok: false, reason: 'too_many_active_holds' });
        }

        const bookingId = uuidv7();
        const allocationRef = bookingId;
        const actor = `customer:${input.customerUserId}`;

        await tx.execute(
          sql`SELECT set_config('booking.actor', ${actor}, true), set_config('booking.reason', 'hold_created', true)`,
        );

        let insertedRow: BookingRow | undefined;
        for (let attempt = 0; attempt < MAX_REFERENCE_RETRIES; attempt++) {
          const candidateRef = generateBookingReference();
          await tx.execute(sql`SAVEPOINT sp_booking_insert`);
          try {
            const [row] = await tx
              .insert(bookingBookings)
              .values({
                id: bookingId,
                reference: candidateRef,
                customerUserId: input.customerUserId,
                productId: snapshot.productId,
                departureId: snapshot.departureId,
                status: 'held',
                pax: {
                  adult: validated.adult,
                  child: validated.child,
                  infant: validated.infant,
                },
                seats: snapshot.seats,
                currency: snapshot.currency,
                totalAmountMinor: BigInt(snapshot.totalAmountMinor),
                quoteSnapshot: snapshot as unknown as Record<string, unknown>,
                snapshotHash: snapshot.snapshotHash,
                contactName: validated.contactName,
                contactEmail: validated.contactEmail,
                contactPhone: validated.contactPhone,
                contactLocale: validated.contactLocale,
                allocationRef,
                holdExpiresAt: sql`now() + make_interval(mins => ${this.holdMinutes})`,
                version: 1,
              })
              .returning();
            await tx.execute(sql`RELEASE SAVEPOINT sp_booking_insert`);
            insertedRow = row;
            break;
          } catch (err: unknown) {
            await tx.execute(sql`ROLLBACK TO SAVEPOINT sp_booking_insert`);
            const code = extractPgField(err, 'code');
            const constraint = extractPgField(err, 'constraint');
            if (
              code === '23505' &&
              constraint === 'bookings_reference_unique' &&
              attempt + 1 < MAX_REFERENCE_RETRIES
            ) {
              continue;
            }
            throw err;
          }
        }

        if (!insertedRow) {
          throw new Error('Failed to generate unique booking reference');
        }

        // Allocate seats atomically within the same transaction (L3: allocationRef === bookingId)
        const allocOutcome = await this.inventoryService.allocate(
          {
            departureId: snapshot.departureId,
            quantity: snapshot.seats,
            refType: 'booking',
            refId: allocationRef,
          },
          tx,
        );

        if (allocOutcome.status !== 'allocated') {
          throw new HoldTransactionAbortError({
            ok: false,
            reason: allocOutcome.status,
          });
        }

        await this.outboxService.enqueue(tx, {
          aggregateType: 'booking',
          aggregateId: insertedRow.id,
          eventType: 'booking.held',
          payload: {
            bookingId: insertedRow.id,
            reference: insertedRow.reference,
            customerUserId: insertedRow.customerUserId,
            productId: insertedRow.productId,
            departureId: insertedRow.departureId,
            seats: insertedRow.seats,
            currency: insertedRow.currency.trim(),
            totalAmountMinor: insertedRow.totalAmountMinor.toString(),
            holdExpiresAt: insertedRow.holdExpiresAt.toISOString(),
          },
        });

        return insertedRow;
      });

      this.logger.log(
        JSON.stringify({
          level: 'info',
          event: 'booking_hold_created',
          bookingId: booking.id,
          reference: booking.reference,
          departureId: booking.departureId,
          seats: booking.seats,
        }),
      );

      const dto: HoldBookingResponseDto = {
        id: booking.id,
        reference: booking.reference,
        status: booking.status as BookingStatus,
        holdExpiresAt: booking.holdExpiresAt.toISOString(),
        totalAmountMinor: booking.totalAmountMinor.toString(),
        currency: booking.currency.trim(),
        seats: booking.seats,
        quote: toPublicQuoteResponse(snapshot, validated.contactLocale),
      };

      return { ok: true, booking: dto };
    } catch (err: unknown) {
      if (err instanceof HoldTransactionAbortError) {
        return err.result;
      }
      throw err;
    }
  }

  async createHoldHttp(input: CreateHoldInput): Promise<HoldBookingResponseDto> {
    const res = await this.createHold(input);
    if (res.ok) {
      return res.booking;
    }

    switch (res.reason) {
      case 'price_changed':
        throw bookingPriceChangedException(res.quote);
      case 'sold_out':
        throw bookingSoldOutException();
      case 'too_many_active_holds':
        throw bookingTooManyActiveHoldsException(MAX_ACTIVE_HOLDS_PER_CUSTOMER);
      case 'closed':
        throw bookingDepartureClosedException();
      case 'cutoff_passed':
        throw bookingCutoffPassedException();
      case 'not_found':
        throw bookingDepartureNotFoundException();
    }
  }

  async markPaymentPending(
    bookingId: string,
    customerUserId: string,
    options?: {
      readonly actor?: string;
      readonly expectedVersion?: number;
      readonly tx?: DatabaseTransaction;
    },
  ): Promise<MarkPaymentPendingResult> {
    if (!UUID_REGEX.test(bookingId)) {
      return { ok: false, reason: 'not_found' };
    }

    const executor = options?.tx ?? this.db;
    const [existing] = await executor
      .select({ id: bookingBookings.id, customerUserId: bookingBookings.customerUserId })
      .from(bookingBookings)
      .where(eq(bookingBookings.id, bookingId))
      .limit(1);

    if (!existing || existing.customerUserId !== customerUserId) {
      return { ok: false, reason: 'not_found' };
    }

    // D-018: require verified email before proceeding toward payment
    const emailVerified = await this.identityService.isEmailVerified(customerUserId);
    if (!emailVerified) {
      return { ok: false, reason: 'email_not_verified' };
    }

    const actor = options?.actor ?? `customer:${customerUserId}`;

    return this.withTx(options?.tx, async (tx) => {
      const outcome = await this.transitionBooking(tx, {
        bookingId,
        actor,
        reason: 'payment_initiated',
        expectedFromStatuses: ['held'],
        targetStatus: 'payment_pending',
        requireNotExpired: true,
        ...(options?.expectedVersion !== undefined
          ? { expectedVersion: options.expectedVersion }
          : {}),
      });

      if (outcome.kind === 'not_found') {
        return { ok: false, reason: 'not_found' };
      }
      if (outcome.kind === 'illegal' || outcome.kind === 'version_conflict') {
        if (outcome.current.customerUserId !== customerUserId) {
          return { ok: false, reason: 'not_found' };
        }
        return { ok: false, reason: 'conflict' };
      }

      await this.outboxService.enqueue(tx, {
        aggregateType: 'booking',
        aggregateId: outcome.booking.id,
        eventType: 'booking.payment_pending',
        payload: {
          bookingId: outcome.booking.id,
          reference: outcome.booking.reference,
          holdExpiresAt: outcome.booking.holdExpiresAt.toISOString(),
        },
      });

      return { ok: true, booking: toBookingDetailDto(outcome.booking) };
    });
  }

  /**
   * Acquires a row-level lock on the customer's booking inside `tx` and prepares it for payment:
   * - Validates ownership (404 if missing or owned by another customer);
   * - Enforces D-018 (`emailVerified`);
   * - Verifies status is `held` or `payment_pending` and `hold_expires_at > now()` (DB clock);
   * - Transitions `held -> payment_pending` if needed.
   */
  async prepareForCheckout(
    rawReference: string,
    customerUserId: string,
    tx: DatabaseTransaction,
  ): Promise<MarkPaymentPendingResult> {
    const reference = normalizeBookingReference(rawReference);
    if (!reference) {
      return { ok: false, reason: 'not_found' };
    }

    const [locked] = await tx
      .select()
      .from(bookingBookings)
      .where(eq(bookingBookings.reference, reference))
      .for('update');

    if (!locked || locked.customerUserId !== customerUserId) {
      return { ok: false, reason: 'not_found' };
    }

    const emailVerified = await this.identityService.isEmailVerified(customerUserId);
    if (!emailVerified) {
      return { ok: false, reason: 'email_not_verified' };
    }

    if (locked.status !== 'held' && locked.status !== 'payment_pending') {
      return { ok: false, reason: 'conflict' };
    }

    const clockRes = await tx.execute(
      sql`SELECT (${locked.holdExpiresAt}::timestamptz > now()) AS "stillValid"`,
    );
    if (clockRes.rows[0]?.['stillValid'] !== true) {
      return { ok: false, reason: 'conflict' };
    }

    if (locked.status === 'held') {
      return this.markPaymentPending(locked.id, customerUserId, { tx });
    }

    return { ok: true, booking: toBookingDetailDto(locked) };
  }

  async markPaymentPendingByReferenceHttp(
    rawReference: string,
    customerUserId: string,
  ): Promise<BookingDetailDto> {
    const reference = normalizeBookingReference(rawReference);
    if (!reference) {
      throw bookingNotFoundException();
    }

    const [found] = await this.db
      .select({ id: bookingBookings.id, customerUserId: bookingBookings.customerUserId })
      .from(bookingBookings)
      .where(eq(bookingBookings.reference, reference))
      .limit(1);

    if (!found || found.customerUserId !== customerUserId) {
      throw bookingNotFoundException();
    }

    const res = await this.markPaymentPending(found.id, customerUserId);
    if (res.ok) {
      return res.booking;
    }
    if (res.reason === 'email_not_verified') {
      throw bookingEmailNotVerifiedException();
    }
    if (res.reason === 'not_found') {
      throw bookingNotFoundException();
    }
    throw bookingConflictException();
  }

  /**
   * Internal API (for P2-05/P2-06 payment capture webhook): idempotently confirms a `payment_pending` booking.
   */
  async confirm(
    bookingId: string,
    paymentRef: string,
    options?: { readonly expectedVersion?: number; readonly tx?: DatabaseTransaction },
  ): Promise<ConfirmBookingResult> {
    if (!UUID_REGEX.test(bookingId)) {
      return { ok: false, reason: 'not_found' };
    }
    const cleanRef = typeof paymentRef === 'string' ? paymentRef.trim() : '';
    if (!cleanRef) {
      throw bookingValidationException('paymentRef is required');
    }

    return this.withTx(options?.tx, async (tx) => {
      const outcome = await this.transitionBooking(tx, {
        bookingId,
        actor: 'system:payment',
        reason: `payment_confirmed:${cleanRef}`,
        expectedFromStatuses: ['payment_pending'],
        targetStatus: 'confirmed',
        paymentRef: cleanRef,
        ...(options?.expectedVersion !== undefined
          ? { expectedVersion: options.expectedVersion }
          : {}),
      });

      if (outcome.kind === 'not_found') {
        return { ok: false, reason: 'not_found' };
      }

      if (outcome.kind === 'version_conflict') {
        return { ok: false, reason: 'conflict' };
      }

      if (outcome.kind === 'illegal') {
        const cur = outcome.current;
        if (cur.status === 'confirmed') {
          if (cur.paymentRef === cleanRef) {
            return { ok: true, booking: toBookingDetailDto(cur) };
          }
          return { ok: false, reason: 'conflict' };
        }
        return { ok: false, reason: 'not_confirmable' };
      }

      await this.outboxService.enqueue(tx, {
        aggregateType: 'booking',
        aggregateId: outcome.booking.id,
        eventType: 'booking.confirmed',
        payload: {
          bookingId: outcome.booking.id,
          reference: outcome.booking.reference,
          paymentRef: cleanRef,
          confirmedAt: outcome.booking.confirmedAt?.toISOString() ?? null,
        },
      });

      return { ok: true, booking: toBookingDetailDto(outcome.booking) };
    });
  }

  async cancelBeforePayment(
    bookingId: string,
    customerUserId: string,
    options?: { readonly expectedVersion?: number },
  ): Promise<CancelBookingResult> {
    if (!UUID_REGEX.test(bookingId)) {
      return { ok: false, reason: 'not_found' };
    }

    return this.db.transaction(async (tx) => {
      const [preCheck] = await tx
        .select({ customerUserId: bookingBookings.customerUserId })
        .from(bookingBookings)
        .where(eq(bookingBookings.id, bookingId))
        .limit(1);

      if (!preCheck || preCheck.customerUserId !== customerUserId) {
        return { ok: false, reason: 'not_found' };
      }

      const outcome = await this.transitionBooking(tx, {
        bookingId,
        actor: `customer:${customerUserId}`,
        reason: 'customer_cancelled_before_payment',
        expectedFromStatuses: ['held', 'payment_pending'],
        targetStatus: 'cancelled',
        ...(options?.expectedVersion !== undefined
          ? { expectedVersion: options.expectedVersion }
          : {}),
      });

      if (outcome.kind === 'not_found') {
        return { ok: false, reason: 'not_found' };
      }

      if (outcome.kind === 'version_conflict') {
        return { ok: false, reason: 'not_cancellable' };
      }

      if (outcome.kind === 'illegal') {
        if (outcome.current.status === 'cancelled') {
          return { ok: true, booking: toBookingDetailDto(outcome.current) };
        }
        return { ok: false, reason: 'not_cancellable' };
      }

      await this.inventoryService.release(
        {
          departureId: outcome.booking.departureId,
          refType: 'booking',
          refId: outcome.booking.allocationRef,
        },
        tx,
      );

      await this.outboxService.enqueue(tx, {
        aggregateType: 'booking',
        aggregateId: outcome.booking.id,
        eventType: 'booking.cancelled',
        payload: {
          bookingId: outcome.booking.id,
          reference: outcome.booking.reference,
          departureId: outcome.booking.departureId,
          seats: outcome.booking.seats,
          cancelledAt: outcome.booking.cancelledAt?.toISOString() ?? null,
        },
      });

      return { ok: true, booking: toBookingDetailDto(outcome.booking) };
    });
  }

  async cancelByReferenceHttp(
    rawReference: string,
    customerUserId: string,
  ): Promise<BookingDetailDto | ConfirmedCancelResponseDto> {
    const reference = normalizeBookingReference(rawReference);
    if (!reference) {
      throw bookingNotFoundException();
    }

    const [found] = await this.db
      .select({
        id: bookingBookings.id,
        customerUserId: bookingBookings.customerUserId,
        status: bookingBookings.status,
        paymentRef: bookingBookings.paymentRef,
      })
      .from(bookingBookings)
      .where(eq(bookingBookings.reference, reference))
      .limit(1);

    if (!found || found.customerUserId !== customerUserId) {
      throw bookingNotFoundException();
    }

    if (
      (found.status === 'confirmed' ||
        (found.status === 'cancelled' && found.paymentRef !== null)) &&
      this.confirmedCancellationPort
    ) {
      return this.confirmedCancellationPort.cancelConfirmedBooking(reference, customerUserId);
    }

    const res = await this.cancelBeforePayment(found.id, customerUserId);
    if (res.ok) {
      return res.booking;
    }
    if (res.reason === 'not_found') {
      throw bookingNotFoundException();
    }
    throw bookingNotCancellableException();
  }

  /**
   * Public transactional API for P2-07 (`payments` module): locks a booking inside `tx`,
   * transitions `confirmed -> cancelled`, releases allocated inventory seats inside the same `tx`,
   * and returns the booking + DB departure timing snapshot (`startsAt`, `dbNow`).
   */
  async cancelConfirmedWithLock(
    bookingIdOrRef: string,
    options: {
      readonly customerUserId?: string;
      readonly actor: string;
      readonly reason: string;
      readonly enforceBeforeStart: boolean;
      readonly tx: DatabaseTransaction;
    },
  ): Promise<
    | { readonly kind: 'not_found' }
    | { readonly kind: 'already_cancelled'; readonly booking: BookingDetailDto }
    | { readonly kind: 'not_confirmed'; readonly status: BookingStatus }
    | { readonly kind: 'too_late' }
    | {
        readonly kind: 'cancelled';
        readonly booking: BookingDetailDto;
        readonly startsAt: Date;
        readonly dbNow: Date;
      }
  > {
    const isUuid = UUID_REGEX.test(bookingIdOrRef);
    const normalizedRef = isUuid ? null : normalizeBookingReference(bookingIdOrRef);
    if (!isUuid && !normalizedRef) {
      return { kind: 'not_found' };
    }

    const [locked] = await options.tx
      .select()
      .from(bookingBookings)
      .where(
        isUuid
          ? eq(bookingBookings.id, bookingIdOrRef)
          : eq(bookingBookings.reference, normalizedRef!),
      )
      .for('update');

    if (
      !locked ||
      (options.customerUserId !== undefined && locked.customerUserId !== options.customerUserId)
    ) {
      return { kind: 'not_found' };
    }

    if (locked.status === 'cancelled') {
      return { kind: 'already_cancelled', booking: toBookingDetailDto(locked) };
    }
    if (locked.status !== 'confirmed') {
      return { kind: 'not_confirmed', status: locked.status as BookingStatus };
    }

    const timing = await this.inventoryService.getDepartureStartsAtWithDbNow(
      locked.departureId,
      options.tx,
    );
    if (!timing) {
      return { kind: 'not_found' };
    }
    if (options.enforceBeforeStart && timing.dbNow.getTime() > timing.startsAt.getTime()) {
      return { kind: 'too_late' };
    }

    const transition = await this.transitionBooking(options.tx, {
      bookingId: locked.id,
      actor: options.actor,
      reason: options.reason,
      expectedFromStatuses: ['confirmed'],
      targetStatus: 'cancelled',
    });

    if (transition.kind === 'illegal') {
      if (transition.current.status === 'cancelled') {
        return { kind: 'already_cancelled', booking: toBookingDetailDto(transition.current) };
      }
      return { kind: 'not_confirmed', status: transition.current.status as BookingStatus };
    }
    if (transition.kind !== 'transitioned') {
      return { kind: 'not_found' };
    }

    await this.inventoryService.release(
      {
        departureId: transition.booking.departureId,
        refType: 'booking',
        refId: transition.booking.allocationRef,
      },
      options.tx,
    );

    await this.outboxService.enqueue(options.tx, {
      aggregateType: 'booking',
      aggregateId: transition.booking.id,
      eventType: 'booking.cancelled',
      payload: {
        bookingId: transition.booking.id,
        reference: transition.booking.reference,
        departureId: transition.booking.departureId,
        seats: transition.booking.seats,
        actor: options.actor,
        reason: options.reason,
        cancelledAt: transition.booking.cancelledAt?.toISOString() ?? null,
      },
    });

    return {
      kind: 'cancelled',
      booking: toBookingDetailDto(transition.booking),
      startsAt: timing.startsAt,
      dbNow: timing.dbNow,
    };
  }

  /**
   * Public transactional API for operator departure cancellation: cancels a held/payment_pending booking
   * without refund and releases its seats in the same `tx`.
   */
  async cancelActiveHoldOnDeparture(
    bookingId: string,
    actor: string,
    reason: string,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    if (!UUID_REGEX.test(bookingId)) {
      return false;
    }
    const transition = await this.transitionBooking(tx, {
      bookingId,
      actor,
      reason,
      expectedFromStatuses: ['held', 'payment_pending'],
      targetStatus: 'cancelled',
    });
    if (transition.kind !== 'transitioned') {
      return false;
    }

    await this.inventoryService.release(
      {
        departureId: transition.booking.departureId,
        refType: 'booking',
        refId: transition.booking.allocationRef,
      },
      tx,
    );

    await this.outboxService.enqueue(tx, {
      aggregateType: 'booking',
      aggregateId: transition.booking.id,
      eventType: 'booking.cancelled',
      payload: {
        bookingId: transition.booking.id,
        reference: transition.booking.reference,
        departureId: transition.booking.departureId,
        seats: transition.booking.seats,
        actor,
        reason,
        cancelledAt: transition.booking.cancelledAt?.toISOString() ?? null,
      },
    });

    return true;
  }

  async listBookingsForDeparture(
    departureId: string,
  ): Promise<
    readonly { readonly id: string; readonly reference: string; readonly status: BookingStatus }[]
  > {
    if (!UUID_REGEX.test(departureId)) {
      return [];
    }
    const rows = await this.db
      .select({
        id: bookingBookings.id,
        reference: bookingBookings.reference,
        status: bookingBookings.status,
      })
      .from(bookingBookings)
      .where(eq(bookingBookings.departureId, departureId));
    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status as BookingStatus,
    }));
  }

  async getBookingSummaryForInternalUse(bookingId: string): Promise<BookingDetailDto | null> {
    if (!UUID_REGEX.test(bookingId)) {
      return null;
    }
    const [row] = await this.db
      .select()
      .from(bookingBookings)
      .where(eq(bookingBookings.id, bookingId))
      .limit(1);
    return row ? toBookingDetailDto(row) : null;
  }

  async expireDue(options: { readonly limit?: number } = {}): Promise<BookingExpiryResult> {
    const rawLimit = options.limit ?? DEFAULT_EXPIRY_LIMIT;
    const limit = Math.min(Math.max(1, Math.trunc(rawLimit)), MAX_EXPIRY_LIMIT);
    let expiredCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < limit; i++) {
      const stepOutcome = await this.db.transaction(async (tx) => {
        const dueRes = await tx.execute(sql`
          SELECT id
          FROM booking.bookings
          WHERE status IN ('held', 'payment_pending')
            AND hold_expires_at <= now()
          ORDER BY hold_expires_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `);
        const dueRow = dueRes.rows[0];
        if (!dueRow) {
          return 'empty' as const;
        }

        const bookingId = String(dueRow['id']);
        const transition = await this.transitionBooking(tx, {
          bookingId,
          actor: 'system:expiry',
          reason: 'hold_expired',
          expectedFromStatuses: ['held', 'payment_pending'],
          targetStatus: 'expired',
        });

        if (transition.kind !== 'transitioned') {
          return 'skipped' as const;
        }

        await this.inventoryService.release(
          {
            departureId: transition.booking.departureId,
            refType: 'booking',
            refId: transition.booking.allocationRef,
          },
          tx,
        );

        await this.outboxService.enqueue(tx, {
          aggregateType: 'booking',
          aggregateId: transition.booking.id,
          eventType: 'booking.expired',
          payload: {
            bookingId: transition.booking.id,
            reference: transition.booking.reference,
            departureId: transition.booking.departureId,
            seats: transition.booking.seats,
            previousStatus: transition.fromStatus,
            expiredAt: transition.booking.expiredAt?.toISOString() ?? null,
          },
        });

        return 'expired' as const;
      });

      if (stepOutcome === 'empty') {
        break;
      }
      if (stepOutcome === 'expired') {
        expiredCount += 1;
      } else {
        skippedCount += 1;
      }
    }

    if (expiredCount > 0) {
      this.logger.log(
        JSON.stringify({
          level: 'info',
          event: 'booking_holds_expired_batch',
          expiredCount,
          skippedCount,
        }),
      );
    }

    return { expiredCount, skippedCount };
  }

  async getBookingForCustomerByReference(
    rawReference: string,
    customerUserId: string,
  ): Promise<BookingDetailDto> {
    const reference = normalizeBookingReference(rawReference);
    if (!reference) {
      throw bookingNotFoundException();
    }

    const [row] = await this.db
      .select()
      .from(bookingBookings)
      .where(
        and(
          eq(bookingBookings.reference, reference),
          eq(bookingBookings.customerUserId, customerUserId),
        ),
      )
      .limit(1);

    if (!row) {
      throw bookingNotFoundException();
    }

    const events = await this.db
      .select()
      .from(bookingEvents)
      .where(eq(bookingEvents.bookingId, row.id))
      .orderBy(bookingEvents.at, bookingEvents.id);

    const payment = this.paymentSummaryPort
      ? await this.paymentSummaryPort.getPaymentSummaryForBooking(row.id)
      : { status: null, attemptCount: 0 };

    const refund = this.paymentSummaryPort?.getRefundSummaryForBooking
      ? await this.paymentSummaryPort.getRefundSummaryForBooking(row.id)
      : null;

    return toBookingDetailDto(row, events.map(toBookingEventDto), payment, refund);
  }

  async listBookingsForCustomer(
    customerUserId: string,
    options: { readonly cursor?: string; readonly limit?: string } = {},
  ): Promise<CustomerBookingListResponse> {
    let limit = DEFAULT_LIST_LIMIT;
    if (options.limit !== undefined && options.limit !== '') {
      const parsed = Number(options.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
        throw bookingInvalidQueryException(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
      }
      limit = parsed;
    }

    const conditions = [eq(bookingBookings.customerUserId, customerUserId)];
    if (options.cursor) {
      const decoded = decodeBookingCursor(options.cursor);
      conditions.push(
        sql`(${bookingBookings.createdAt}, ${bookingBookings.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
      );
    }

    const rows = await this.db
      .select()
      .from(bookingBookings)
      .where(and(...conditions))
      .orderBy(desc(bookingBookings.createdAt), desc(bookingBookings.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeBookingCursor({ createdAt: lastRow.createdAt.toISOString(), id: lastRow.id })
        : null;

    return {
      items: pageRows.map((row) => toBookingDetailDto(row)),
      nextCursor,
    };
  }

  async listAdminBookings(query: AdminBookingListQuery = {}): Promise<CustomerBookingListResponse> {
    let limit = DEFAULT_LIST_LIMIT;
    if (query.limit !== undefined && query.limit !== '') {
      const parsed = Number(query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
        throw bookingInvalidQueryException(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
      }
      limit = parsed;
    }

    const conditions = [];
    if (query.status !== undefined && query.status !== '') {
      const validStatuses = ['held', 'payment_pending', 'confirmed', 'expired', 'cancelled'];
      if (!validStatuses.includes(query.status)) {
        throw bookingInvalidQueryException(`status must be one of: ${validStatuses.join(', ')}`);
      }
      conditions.push(eq(bookingBookings.status, query.status));
    }

    if (query.departureId !== undefined && query.departureId !== '') {
      if (!UUID_REGEX.test(query.departureId)) {
        throw bookingInvalidQueryException('departureId must be a valid UUID');
      }
      conditions.push(eq(bookingBookings.departureId, query.departureId));
    }

    if (query.reference !== undefined && query.reference.trim() !== '') {
      const normalizedRef = normalizeBookingReference(query.reference);
      if (!normalizedRef) {
        return { items: [], nextCursor: null };
      }
      conditions.push(eq(bookingBookings.reference, normalizedRef));
    }

    if (query.from !== undefined && query.from !== '') {
      if (!LOCAL_DATE_REGEX.test(query.from)) {
        throw bookingInvalidQueryException('from must be YYYY-MM-DD');
      }
      conditions.push(gte(bookingBookings.createdAt, new Date(`${query.from}T00:00:00.000Z`)));
    }

    if (query.to !== undefined && query.to !== '') {
      if (!LOCAL_DATE_REGEX.test(query.to)) {
        throw bookingInvalidQueryException('to must be YYYY-MM-DD');
      }
      conditions.push(lte(bookingBookings.createdAt, new Date(`${query.to}T23:59:59.999Z`)));
    }

    if (query.cursor) {
      const decoded = decodeBookingCursor(query.cursor);
      conditions.push(
        sql`(${bookingBookings.createdAt}, ${bookingBookings.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
      );
    }

    const rows = await this.db
      .select()
      .from(bookingBookings)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(bookingBookings.createdAt), desc(bookingBookings.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeBookingCursor({ createdAt: lastRow.createdAt.toISOString(), id: lastRow.id })
        : null;

    return {
      items: pageRows.map((row) => toBookingDetailDto(row)),
      nextCursor,
    };
  }
}
