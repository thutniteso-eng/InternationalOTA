import {
  and,
  type DatabaseClient,
  type DatabaseTransaction,
  desc,
  eq,
  inArray,
  lte,
  type OutboxEvent,
  paymentsPaymentAttempts,
  paymentsRefunds,
  type RefundReason,
  type RefundRow,
  sql,
} from '@internationalota/db';
import { type CurrencyCode, createMoney } from '@internationalota/money';
import { parseLocalDate } from '@internationalota/time';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  bookingNotCancellableException,
  bookingNotFoundException,
  type BookingRefundSummaryDto,
  BookingService,
  bookingTooLateToCancelException,
  type ConfirmedBookingCancellationPort,
  type ConfirmedCancelResponseDto,
} from '../booking/index.js';
import { LedgerService, type PostJournalLineInput } from '../finance/index.js';
import { InventoryService } from '../inventory/index.js';
import {
  calculateExponentialBackoffMs,
  type DepartureBookingCancelWorkerPort,
  JobQueueService,
  OutboxService,
  QUEUE_DEPARTURE_BOOKING_CANCEL,
  type RefundExecutorWorkerPort,
} from '../messaging/index.js';
import { computeRefund } from '../pricing/index.js';
import { PaymentProviderRegistry } from './payment-provider.registry.js';
import {
  departureCancelReasonRequiredException,
  paymentRefundNotFoundException,
  paymentRefundNotRetryableException,
} from './payments.errors.js';
import type {
  AdminRefundDto,
  BookingCancellationPreviewDto,
  DepartureCancellationSummaryDto,
  DepartureCancelResultDto,
  RefundVerificationResult,
} from './payments.types.js';

const MAX_REFUND_ATTEMPTS = 3;
const REFUND_BASE_BACKOFF_MS = 1000;
const REFUND_EXECUTOR_BATCH_LIMIT = 50;
const PROVIDER_CALL_TIMEOUT_MS = 10_000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function toAdminRefundDto(row: RefundRow): AdminRefundDto {
  return {
    id: row.id,
    bookingId: row.bookingId,
    paymentAttemptId: row.paymentAttemptId,
    provider: row.provider,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency.trim(),
    reason: row.reason,
    status: row.status,
    providerRefundRef: row.providerRefundRef,
    attempts: row.attempts,
    lastError: row.lastError,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

interface PendingDepartureCancelPayload {
  readonly bookingId: string;
  readonly departureId: string;
  readonly adminUserId: string;
  readonly reason: string;
}

@Injectable()
export class RefundService
  implements
    OnModuleInit,
    ConfirmedBookingCancellationPort,
    RefundExecutorWorkerPort,
    DepartureBookingCancelWorkerPort
{
  private readonly logger = new Logger(RefundService.name);
  private readonly queuedFallbackDepartureJobs: PendingDepartureCancelPayload[] = [];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly bookingService: BookingService,
    private readonly inventoryService: InventoryService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly registry: PaymentProviderRegistry,
    @Optional() private readonly jobQueueService?: JobQueueService,
  ) {}

  onModuleInit(): void {
    this.outboxService.registerHandler('payment.refund_required', async (event) => {
      await this.handlePaymentRefundRequiredEvent(event);
    });
  }

  /**
   * Read-only preview of customer cancellation outcome evaluated against DB `now()`.
   */
  async previewCancellation(
    rawReference: string,
    customerUserId: string,
  ): Promise<BookingCancellationPreviewDto> {
    const booking = await this.bookingService.getBookingForCustomerByReference(
      rawReference,
      customerUserId,
    );

    if (booking.status === 'held' || booking.status === 'payment_pending') {
      return {
        status: booking.status,
        currency: booking.currency.trim(),
        totalAmountMinor: booking.totalAmountMinor,
        refundAmountMinor: '0',
        cancellable: true,
        reason: 'not_paid',
      };
    }

    if (booking.status !== 'confirmed') {
      return {
        status: booking.status,
        currency: booking.currency.trim(),
        totalAmountMinor: booking.totalAmountMinor,
        refundAmountMinor: '0',
        cancellable: false,
        reason: booking.status === 'cancelled' ? 'already_cancelled' : 'not_cancellable',
      };
    }

    const timing = await this.inventoryService.getDepartureStartsAtWithDbNow(booking.departureId);
    if (!timing || timing.dbNow.getTime() > timing.startsAt.getTime()) {
      return {
        status: booking.status,
        currency: booking.currency.trim(),
        totalAmountMinor: booking.totalAmountMinor,
        refundAmountMinor: '0',
        refundPercent: 0,
        ruleApplied: null,
        cancellable: false,
        reason: 'too_late_to_cancel',
      };
    }

    const currency = booking.currency.trim() as CurrencyCode;
    const calc = computeRefund({
      paidAmountMinor: BigInt(booking.totalAmountMinor),
      currency,
      rules: booking.quoteSnapshot.rules,
      startsAt: timing.startsAt,
      cancelledAt: timing.dbNow,
    });

    return {
      status: booking.status,
      currency,
      totalAmountMinor: booking.totalAmountMinor,
      refundAmountMinor: calc.refundAmountMinor.toString(),
      refundPercent: calc.refundPercent,
      ruleApplied: calc.ruleApplied,
      cancellable: true,
    };
  }

  /**
   * Customer cancels a confirmed booking (POST /bookings/:reference/cancel).
   * - Evaluates refund policy using DB `now()` and booking's own quote snapshot rules;
   * - Enforces `dbNow <= startsAt` (409 `too_late_to_cancel`);
   * - Transitions `confirmed -> cancelled`, releases seats, creates refund if R > 0,
   *   and posts `Dr customer_prepayments / Cr refunds_payable / Cr cancellation_retained`
   *   atomically in a single PostgreSQL transaction.
   */
  async cancelConfirmedBooking(
    reference: string,
    customerUserId: string,
  ): Promise<ConfirmedCancelResponseDto> {
    let createdRefundId: string | null = null;

    const result = await this.db.transaction(async (tx) => {
      const cancelRes = await this.bookingService.cancelConfirmedWithLock(reference, {
        customerUserId,
        actor: `customer:${customerUserId}`,
        reason: 'customer_cancelled',
        enforceBeforeStart: true,
        tx,
      });

      if (cancelRes.kind === 'not_found') {
        throw bookingNotFoundException();
      }
      if (cancelRes.kind === 'too_late') {
        throw bookingTooLateToCancelException();
      }
      if (cancelRes.kind === 'not_confirmed') {
        throw bookingNotCancellableException();
      }

      if (cancelRes.kind === 'already_cancelled') {
        const [existingRefund] = await tx
          .select()
          .from(paymentsRefunds)
          .where(eq(paymentsRefunds.bookingId, cancelRes.booking.id))
          .orderBy(desc(paymentsRefunds.createdAt))
          .limit(1);

        const existingCancelledAt = cancelRes.booking.cancelledAt ?? new Date().toISOString();
        const existingCalc = computeRefund({
          paidAmountMinor: BigInt(cancelRes.booking.totalAmountMinor),
          currency: cancelRes.booking.currency.trim() as CurrencyCode,
          rules: cancelRes.booking.quoteSnapshot.rules,
          startsAt: cancelRes.booking.quoteSnapshot.startsAt,
          cancelledAt: existingCancelledAt,
        });

        return {
          ...cancelRes.booking,
          ...(existingRefund
            ? {
                refund: {
                  amountMinor: existingRefund.amountMinor.toString(),
                  status: existingRefund.status,
                },
              }
            : {}),
          refundAmountMinor: existingRefund
            ? existingRefund.amountMinor.toString()
            : existingCalc.refundAmountMinor.toString(),
          refundPercent: existingCalc.refundPercent,
          ruleApplied: existingCalc.ruleApplied,
        };
      }

      const booking = cancelRes.booking;
      const paidMinor = BigInt(booking.totalAmountMinor);
      const currency = booking.currency.trim() as CurrencyCode;

      const calc = computeRefund({
        paidAmountMinor: paidMinor,
        currency,
        rules: booking.quoteSnapshot.rules,
        startsAt: cancelRes.startsAt,
        cancelledAt: cancelRes.dbNow,
      });

      const refundAmountMinor = calc.refundAmountMinor;
      const retainedAmountMinor = paidMinor - refundAmountMinor;

      const [succeededAttempt] = await tx
        .select()
        .from(paymentsPaymentAttempts)
        .where(
          and(
            eq(paymentsPaymentAttempts.bookingId, booking.id),
            eq(paymentsPaymentAttempts.status, 'succeeded'),
          ),
        )
        .limit(1);

      if (!succeededAttempt) {
        throw new Error(`No succeeded payment attempt found for confirmed booking ${booking.id}`);
      }

      let refundSummary: BookingRefundSummaryDto | undefined;
      if (refundAmountMinor > 0n) {
        const [insertedRefund] = await tx
          .insert(paymentsRefunds)
          .values({
            bookingId: booking.id,
            paymentAttemptId: succeededAttempt.id,
            provider: succeededAttempt.provider,
            amountMinor: refundAmountMinor,
            currency,
            reason: 'customer_cancellation',
            status: 'requested',
            attempts: 0,
            version: 1,
          })
          .returning();

        if (!insertedRefund) {
          throw new Error(`Failed to create refund for booking ${booking.id}`);
        }
        createdRefundId = insertedRefund.id;
        refundSummary = {
          amountMinor: insertedRefund.amountMinor.toString(),
          status: insertedRefund.status,
        };

        await this.outboxService.enqueue(tx, {
          aggregateType: 'refund',
          aggregateId: insertedRefund.id,
          eventType: 'refund.requested',
          payload: {
            refundId: insertedRefund.id,
            bookingId: booking.id,
            paymentAttemptId: succeededAttempt.id,
            amountMinor: refundAmountMinor.toString(),
            currency,
            reason: 'customer_cancellation',
          },
        });
      }

      // Ledger posting (Omit zero lines cleanly)
      const effectiveDate = parseLocalDate(new Date().toISOString().slice(0, 10));
      const prepaymentsAccount = await this.ledgerService.ensureAccount(tx, {
        code: `liability:customer_prepayments:${currency}`,
        name: `Customer Prepayments (${currency})`,
        type: 'liability',
        currency,
      });

      const lines: PostJournalLineInput[] = [
        {
          accountId: prepaymentsAccount.id,
          side: 'debit',
          amount: createMoney(paidMinor, currency),
          memo: booking.reference,
        },
      ];

      if (refundAmountMinor > 0n) {
        const refundsPayableAccount = await this.ledgerService.ensureAccount(tx, {
          code: `liability:refunds_payable:${currency}`,
          name: `Refunds Payable (${currency})`,
          type: 'liability',
          currency,
        });
        lines.push({
          accountId: refundsPayableAccount.id,
          side: 'credit' as const,
          amount: createMoney(refundAmountMinor, currency),
          memo: booking.reference,
        });
      }

      if (retainedAmountMinor > 0n) {
        const retainedAccount = await this.ledgerService.ensureAccount(tx, {
          code: `liability:cancellation_retained:${currency}`,
          name: `Cancellation Retained (${currency})`,
          type: 'liability',
          currency,
        });
        lines.push({
          accountId: retainedAccount.id,
          side: 'credit' as const,
          amount: createMoney(retainedAmountMinor, currency),
          memo: booking.reference,
        });
      }

      await this.ledgerService.post(tx, {
        effectiveDate,
        description: `Customer cancellation settlement for booking ${booking.reference}`,
        sourceType: 'booking_cancellation',
        sourceId: booking.id,
        entryKind: 'customer_cancellation',
        lines,
      });

      return {
        ...booking,
        ...(refundSummary ? { refund: refundSummary } : {}),
        refundAmountMinor: refundAmountMinor.toString(),
        refundPercent: calc.refundPercent,
        ruleApplied: calc.ruleApplied,
      };
    });

    if (createdRefundId) {
      this.jobQueueService?.triggerRefundExecutorAsync();
    }
    this.jobQueueService?.triggerOutboxRelayAsync();

    return result;
  }

  /**
   * Operator cancels a departure (`POST /admin/departures/:id/cancel`):
   * - Sets departure `cancelled` via InventoryService;
   * - Cancels active holds (`held` / `payment_pending`) without refund;
   * - Enqueues one cancellation+100%-refund job per `confirmed` booking.
   */
  async cancelDeparture(
    departureId: string,
    adminUserId: string,
    rawReason: string | undefined,
  ): Promise<DepartureCancelResultDto> {
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (!reason) {
      throw departureCancelReasonRequiredException();
    }

    await this.inventoryService.cancelDeparture(departureId);

    const bookings = await this.bookingService.listBookingsForDeparture(departureId);
    const activeHolds = bookings.filter(
      (b) => b.status === 'held' || b.status === 'payment_pending',
    );
    const confirmedBookings = bookings.filter((b) => b.status === 'confirmed');

    let activeHoldsCancelledCount = 0;
    if (activeHolds.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const hold of activeHolds) {
          const cancelled = await this.bookingService.cancelActiveHoldOnDeparture(
            hold.id,
            `admin:${adminUserId}`,
            `departure_cancelled:${reason}`,
            tx,
          );
          if (cancelled) {
            activeHoldsCancelledCount += 1;
          }
        }
      });
    }

    for (const conf of confirmedBookings) {
      const payload: PendingDepartureCancelPayload = {
        bookingId: conf.id,
        departureId,
        adminUserId,
        reason,
      };
      if (this.jobQueueService?.isStarted()) {
        await this.jobQueueService.sendJob(
          QUEUE_DEPARTURE_BOOKING_CANCEL,
          { ...payload },
          { singletonKey: conf.id },
        );
      } else {
        this.queuedFallbackDepartureJobs.push(payload);
      }
    }

    return {
      departureId,
      departureStatus: 'cancelled',
      reason,
      activeHoldsCancelledCount,
      confirmedJobsEnqueuedCount: confirmedBookings.length,
      totalBookingsMatched: activeHolds.length + confirmedBookings.length,
    };
  }

  async drainPendingDepartureCancelJobs(): Promise<number> {
    let processed = 0;
    while (this.queuedFallbackDepartureJobs.length > 0) {
      const nextJob = this.queuedFallbackDepartureJobs.shift();
      if (!nextJob) break;
      await this.executeDepartureBookingCancel({ ...nextJob });
      processed += 1;
    }
    return processed;
  }

  async executeDepartureBookingCancel(payload: Record<string, unknown>): Promise<void> {
    const bookingId = typeof payload['bookingId'] === 'string' ? payload['bookingId'] : '';
    const adminUserId = typeof payload['adminUserId'] === 'string' ? payload['adminUserId'] : '';
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : 'operator_cancelled';
    if (!bookingId || !adminUserId) {
      return;
    }

    let createdRefundId: string | null = null;

    await this.db.transaction(async (tx) => {
      const cancelRes = await this.bookingService.cancelConfirmedWithLock(bookingId, {
        actor: `admin:${adminUserId}`,
        reason: `departure_cancelled:${reason}`,
        enforceBeforeStart: false,
        tx,
      });

      if (cancelRes.kind !== 'cancelled') {
        return;
      }

      const booking = cancelRes.booking;
      const paidMinor = BigInt(booking.totalAmountMinor);
      const currency = booking.currency.trim() as CurrencyCode;

      const [succeededAttempt] = await tx
        .select()
        .from(paymentsPaymentAttempts)
        .where(
          and(
            eq(paymentsPaymentAttempts.bookingId, booking.id),
            eq(paymentsPaymentAttempts.status, 'succeeded'),
          ),
        )
        .limit(1);

      if (!succeededAttempt) {
        throw new Error(`No succeeded payment attempt found for confirmed booking ${booking.id}`);
      }

      if (paidMinor > 0n) {
        const [insertedRefund] = await tx
          .insert(paymentsRefunds)
          .values({
            bookingId: booking.id,
            paymentAttemptId: succeededAttempt.id,
            provider: succeededAttempt.provider,
            amountMinor: paidMinor,
            currency,
            reason: 'departure_cancelled',
            status: 'requested',
            attempts: 0,
            version: 1,
          })
          .returning();

        if (insertedRefund) {
          createdRefundId = insertedRefund.id;
          await this.outboxService.enqueue(tx, {
            aggregateType: 'refund',
            aggregateId: insertedRefund.id,
            eventType: 'refund.requested',
            payload: {
              refundId: insertedRefund.id,
              bookingId: booking.id,
              paymentAttemptId: succeededAttempt.id,
              amountMinor: paidMinor.toString(),
              currency,
              reason: 'departure_cancelled',
            },
          });
        }

        const effectiveDate = parseLocalDate(new Date().toISOString().slice(0, 10));
        const prepaymentsAccount = await this.ledgerService.ensureAccount(tx, {
          code: `liability:customer_prepayments:${currency}`,
          name: `Customer Prepayments (${currency})`,
          type: 'liability',
          currency,
        });
        const refundsPayableAccount = await this.ledgerService.ensureAccount(tx, {
          code: `liability:refunds_payable:${currency}`,
          name: `Refunds Payable (${currency})`,
          type: 'liability',
          currency,
        });

        await this.ledgerService.post(tx, {
          effectiveDate,
          description: `Operator departure cancellation 100% refund for booking ${booking.reference}`,
          sourceType: 'booking_cancellation',
          sourceId: booking.id,
          entryKind: 'departure_cancellation',
          lines: [
            {
              accountId: prepaymentsAccount.id,
              side: 'debit',
              amount: createMoney(paidMinor, currency),
              memo: booking.reference,
            },
            {
              accountId: refundsPayableAccount.id,
              side: 'credit',
              amount: createMoney(paidMinor, currency),
              memo: reason,
            },
          ],
        });
      }
    });

    if (createdRefundId) {
      this.jobQueueService?.triggerRefundExecutorAsync();
    }
  }

  async getDepartureCancellationSummary(
    departureId: string,
  ): Promise<DepartureCancellationSummaryDto> {
    const dep = await this.inventoryService.getDepartureQuoteTarget(departureId);
    if (!dep) {
      throw bookingNotFoundException();
    }

    const bookings = await this.bookingService.listBookingsForDeparture(departureId);
    const bookingIds = bookings.map((b) => b.id);
    const refundRows =
      bookingIds.length > 0
        ? await this.db
            .select()
            .from(paymentsRefunds)
            .where(inArray(paymentsRefunds.bookingId, bookingIds))
        : [];

    return {
      departureId,
      departureStatus: dep.status,
      bookings: {
        total: bookings.length,
        confirmed: bookings.filter((b) => b.status === 'confirmed').length,
        cancelled: bookings.filter((b) => b.status === 'cancelled').length,
        held: bookings.filter((b) => b.status === 'held').length,
        paymentPending: bookings.filter((b) => b.status === 'payment_pending').length,
        expired: bookings.filter((b) => b.status === 'expired').length,
      },
      refunds: {
        total: refundRows.length,
        requested: refundRows.filter((r) => r.status === 'requested').length,
        processing: refundRows.filter((r) => r.status === 'processing').length,
        succeeded: refundRows.filter((r) => r.status === 'succeeded').length,
        failed: refundRows.filter((r) => r.status === 'failed').length,
        manualReview: refundRows.filter((r) => r.status === 'manual_review').length,
      },
    };
  }

  /**
   * Consumes `payment.refund_required` outbox events (from late or double payments in P2-05).
   * Idempotent: creates at most one refund row per `(payment_attempt_id, reason)`; no new ledger
   * entry is posted at creation because P2-05 already credited `liability:refunds_payable:<CUR>`.
   */
  async handlePaymentRefundRequiredEvent(event: OutboxEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const attemptId = typeof payload['attemptId'] === 'string' ? payload['attemptId'] : '';
    const rawReason = typeof payload['reason'] === 'string' ? payload['reason'] : '';
    if (!attemptId) {
      return;
    }

    const refundReason: RefundReason =
      rawReason === 'double_payment' ? 'double_payment' : 'late_payment';

    let createdRefundId: string | null = null;

    await this.db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(paymentsPaymentAttempts)
        .where(eq(paymentsPaymentAttempts.id, attemptId))
        .for('update');

      if (!attempt || attempt.status !== 'refund_required') {
        return;
      }

      const [existing] = await tx
        .select({ id: paymentsRefunds.id })
        .from(paymentsRefunds)
        .where(
          and(
            eq(paymentsRefunds.paymentAttemptId, attempt.id),
            eq(paymentsRefunds.reason, refundReason),
          ),
        )
        .limit(1);

      if (existing) {
        return;
      }

      const [inserted] = await tx
        .insert(paymentsRefunds)
        .values({
          bookingId: attempt.bookingId,
          paymentAttemptId: attempt.id,
          provider: attempt.provider,
          amountMinor: attempt.amountMinor,
          currency: attempt.currency.trim(),
          reason: refundReason,
          status: 'requested',
          attempts: 0,
          version: 1,
        })
        .returning();

      if (inserted) {
        createdRefundId = inserted.id;
        await this.outboxService.enqueue(tx, {
          aggregateType: 'refund',
          aggregateId: inserted.id,
          eventType: 'refund.requested',
          payload: {
            refundId: inserted.id,
            bookingId: inserted.bookingId,
            paymentAttemptId: inserted.paymentAttemptId,
            amountMinor: inserted.amountMinor.toString(),
            currency: inserted.currency.trim(),
            reason: refundReason,
          },
        });
      }
    });

    if (createdRefundId) {
      this.jobQueueService?.triggerRefundExecutorAsync();
    }
  }

  /**
   * Executor job: claims due `requested` or retryable `failed` refunds with `SKIP LOCKED`,
   * transitions to `processing`, calls `provider.refund(...)` outside DB transactions, and
   * persists `providerRefundRef` or handles failure -> backoff / `manual_review` after 3 tries.
   */
  async processDueRefunds(): Promise<{
    readonly processedCount: number;
    readonly failedCount: number;
    readonly manualReviewCount: number;
  }> {
    let processedCount = 0;
    let failedCount = 0;
    let manualReviewCount = 0;

    for (let i = 0; i < REFUND_EXECUTOR_BATCH_LIMIT; i++) {
      // Tx1: claim one due refund with SKIP LOCKED -> mark processing
      const claimed = await this.db.transaction(async (tx) => {
        const [due] = await tx
          .select()
          .from(paymentsRefunds)
          .where(
            and(
              inArray(paymentsRefunds.status, ['requested', 'failed']),
              lte(paymentsRefunds.nextAttemptAt, sql`now()`),
            ),
          )
          .orderBy(paymentsRefunds.nextAttemptAt, paymentsRefunds.createdAt)
          .limit(1)
          .for('update', { skipLocked: true });

        if (!due) {
          return null;
        }

        const [attempt] = await tx
          .select()
          .from(paymentsPaymentAttempts)
          .where(eq(paymentsPaymentAttempts.id, due.paymentAttemptId))
          .limit(1);

        if (!attempt || !attempt.providerRef) {
          throw new Error(`Missing providerRef on payment attempt ${due.paymentAttemptId}`);
        }

        const nextAttempts = due.attempts + 1;
        const [updated] = await tx
          .update(paymentsRefunds)
          .set({
            status: 'processing',
            attempts: nextAttempts,
            version: due.version + 1,
            updatedAt: sql`now()`,
          })
          .where(and(eq(paymentsRefunds.id, due.id), eq(paymentsRefunds.version, due.version)))
          .returning();

        if (!updated) {
          return null;
        }

        return { refund: updated, providerRef: attempt.providerRef };
      });

      if (!claimed) {
        break;
      }

      processedCount += 1;
      const provider = this.registry.get(claimed.refund.provider);
      if (!provider) {
        const movedToManual = await this.db.transaction((tx) =>
          this.handleRefundFailureInTx(
            tx,
            claimed.refund.id,
            `No provider registered for "${claimed.refund.provider}"`,
          ),
        );
        if (movedToManual) {
          manualReviewCount += 1;
        } else {
          failedCount += 1;
        }
        continue;
      }

      try {
        const providerResult = await withTimeout(
          provider.refund({
            refundId: claimed.refund.id,
            providerRef: claimed.providerRef,
            amountMinor: claimed.refund.amountMinor,
            currency: claimed.refund.currency.trim(),
            reason: claimed.refund.reason,
          }),
          PROVIDER_CALL_TIMEOUT_MS,
          `${provider.provider}.refund`,
        );

        // Tx2: record providerRefundRef if not already set (or callback hasn't finalised it concurrently)
        await this.db.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(paymentsRefunds)
            .where(eq(paymentsRefunds.id, claimed.refund.id))
            .for('update');
          if (!locked || locked.status !== 'processing' || locked.providerRefundRef !== null) {
            return;
          }
          await tx
            .update(paymentsRefunds)
            .set({
              providerRefundRef: providerResult.providerRefundRef,
              version: locked.version + 1,
              updatedAt: sql`now()`,
            })
            .where(
              and(eq(paymentsRefunds.id, locked.id), eq(paymentsRefunds.version, locked.version)),
            );
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const movedToManual = await this.db.transaction((tx) =>
          this.handleRefundFailureInTx(tx, claimed.refund.id, message),
        );
        if (movedToManual) {
          manualReviewCount += 1;
        } else {
          failedCount += 1;
        }
      }
    }

    return { processedCount, failedCount, manualReviewCount };
  }

  private async handleRefundFailureInTx(
    tx: DatabaseTransaction,
    refundId: string,
    errorMessage: string,
  ): Promise<boolean> {
    const [locked] = await tx
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.id, refundId))
      .for('update');

    if (!locked || (locked.status !== 'processing' && locked.status !== 'failed')) {
      return false;
    }

    if (locked.attempts >= MAX_REFUND_ATTEMPTS) {
      const [updated] = await tx
        .update(paymentsRefunds)
        .set({
          status: 'manual_review',
          lastError: errorMessage,
          version: locked.version + 1,
          updatedAt: sql`now()`,
        })
        .where(and(eq(paymentsRefunds.id, locked.id), eq(paymentsRefunds.version, locked.version)))
        .returning();

      if (updated) {
        await this.outboxService.enqueue(tx, {
          aggregateType: 'refund',
          aggregateId: updated.id,
          eventType: 'refund.manual_review',
          payload: {
            refundId: updated.id,
            bookingId: updated.bookingId,
            paymentAttemptId: updated.paymentAttemptId,
            attempts: updated.attempts,
            lastError: errorMessage,
          },
        });
        this.logger.error(
          JSON.stringify({
            level: 'error',
            event: 'refund_moved_to_manual_review',
            refundId: updated.id,
            bookingId: updated.bookingId,
            attempts: updated.attempts,
            error: errorMessage,
          }),
        );
      }
      return true;
    }

    const backoffMs = calculateExponentialBackoffMs(locked.attempts, REFUND_BASE_BACKOFF_MS);
    await tx
      .update(paymentsRefunds)
      .set({
        status: 'failed',
        lastError: errorMessage,
        nextAttemptAt: sql`now() + (${backoffMs} * interval '1 millisecond')`,
        version: locked.version + 1,
        updatedAt: sql`now()`,
      })
      .where(and(eq(paymentsRefunds.id, locked.id), eq(paymentsRefunds.version, locked.version)));

    this.logger.warn(
      JSON.stringify({
        level: 'warn',
        event: 'refund_attempt_failed_scheduled_retry',
        refundId: locked.id,
        attempts: locked.attempts,
        backoffMs,
        error: errorMessage,
      }),
    );
    return false;
  }

  /**
   * Handles verified `refund.succeeded` and `refund.failed` callbacks inside InboxService's
   * atomic savepoint transaction `tx`.
   */
  async handleRefundWebhook(
    tx: DatabaseTransaction,
    provider: string,
    verification: RefundVerificationResult,
  ): Promise<'processed' | 'noop'> {
    const [refund] = verification.refundId
      ? await tx
          .select()
          .from(paymentsRefunds)
          .where(eq(paymentsRefunds.id, verification.refundId))
          .for('update')
      : await tx
          .select()
          .from(paymentsRefunds)
          .where(
            and(
              eq(paymentsRefunds.provider, provider),
              eq(paymentsRefunds.providerRefundRef, verification.providerRefundRef),
            ),
          )
          .for('update');

    if (!refund) {
      throw new Error(
        `Refund not found for provider="${provider}" providerRefundRef="${verification.providerRefundRef}"`,
      );
    }

    if (refund.status === 'succeeded') {
      this.logger.log(
        JSON.stringify({
          level: 'info',
          event: 'refund_callback_already_succeeded',
          refundId: refund.id,
          eventId: verification.eventId,
        }),
      );
      return 'noop';
    }

    const refundCurrency = refund.currency.trim() as CurrencyCode;
    if (
      verification.amountMinor !== refund.amountMinor ||
      verification.currency !== refundCurrency
    ) {
      await this.handleRefundFailureInTx(
        tx,
        refund.id,
        `Refund callback amount/currency mismatch: expected ${refund.amountMinor} ${refundCurrency}, got ${verification.amountMinor} ${verification.currency}`,
      );
      return 'processed';
    }

    if (verification.outcome === 'failed') {
      await this.handleRefundFailureInTx(tx, refund.id, 'Provider reported refund.failed');
      return 'processed';
    }

    if (refund.status !== 'processing') {
      this.logger.log(
        JSON.stringify({
          level: 'info',
          event: 'refund_callback_unexpected_status',
          refundId: refund.id,
          currentStatus: refund.status,
          eventId: verification.eventId,
        }),
      );
      return 'noop';
    }

    const [updated] = await tx
      .update(paymentsRefunds)
      .set({
        status: 'succeeded',
        lastError: null,
        completedAt: sql`now()`,
        ...(refund.providerRefundRef === null
          ? { providerRefundRef: verification.providerRefundRef }
          : {}),
        version: refund.version + 1,
        updatedAt: sql`now()`,
      })
      .where(and(eq(paymentsRefunds.id, refund.id), eq(paymentsRefunds.version, refund.version)))
      .returning();

    if (!updated) {
      return 'noop';
    }

    const effectiveDate = parseLocalDate(new Date().toISOString().slice(0, 10));
    const amountMoney = createMoney(refund.amountMinor, refundCurrency);
    const refundsPayableAccount = await this.ledgerService.ensureAccount(tx, {
      code: `liability:refunds_payable:${refundCurrency}`,
      name: `Refunds Payable (${refundCurrency})`,
      type: 'liability',
      currency: refundCurrency,
    });
    const clearingAccount = await this.ledgerService.ensureAccount(tx, {
      code: `asset:psp_clearing:${refund.provider}:${refundCurrency}`,
      name: `PSP Clearing (${refund.provider} ${refundCurrency})`,
      type: 'asset',
      currency: refundCurrency,
    });

    await this.ledgerService.post(tx, {
      effectiveDate,
      description: `Refund settled for booking ${refund.bookingId} (${refund.provider})`,
      sourceType: 'refund',
      sourceId: refund.id,
      entryKind: 'refund_settled',
      lines: [
        {
          accountId: refundsPayableAccount.id,
          side: 'debit',
          amount: amountMoney,
          memo: verification.providerRefundRef,
        },
        {
          accountId: clearingAccount.id,
          side: 'credit',
          amount: amountMoney,
          memo: verification.providerRefundRef,
        },
      ],
    });

    await this.outboxService.enqueue(tx, {
      aggregateType: 'refund',
      aggregateId: refund.id,
      eventType: 'refund.succeeded',
      payload: {
        refundId: refund.id,
        bookingId: refund.bookingId,
        paymentAttemptId: refund.paymentAttemptId,
        provider: refund.provider,
        providerRefundRef: verification.providerRefundRef,
        amountMinor: refund.amountMinor.toString(),
        currency: refundCurrency,
      },
    });

    return 'processed';
  }

  /**
   * Admin manual retry (`POST /admin/refunds/:id/retry`): `manual_review -> requested`.
   */
  async adminRetryRefund(refundId: string, adminUserId: string): Promise<AdminRefundDto> {
    if (!UUID_REGEX.test(refundId)) {
      throw paymentRefundNotFoundException();
    }

    const retried = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(paymentsRefunds)
        .where(eq(paymentsRefunds.id, refundId))
        .for('update');

      if (!locked) {
        throw paymentRefundNotFoundException();
      }
      if (locked.status !== 'manual_review') {
        throw paymentRefundNotRetryableException();
      }

      const [updated] = await tx
        .update(paymentsRefunds)
        .set({
          status: 'requested',
          attempts: 0,
          lastError: null,
          nextAttemptAt: sql`now()`,
          version: locked.version + 1,
          updatedAt: sql`now()`,
        })
        .where(and(eq(paymentsRefunds.id, locked.id), eq(paymentsRefunds.version, locked.version)))
        .returning();

      if (!updated) {
        throw paymentRefundNotRetryableException();
      }

      await this.outboxService.enqueue(tx, {
        aggregateType: 'refund',
        aggregateId: updated.id,
        eventType: 'refund.retry_requested',
        payload: {
          refundId: updated.id,
          adminUserId,
        },
      });

      return updated;
    });

    this.jobQueueService?.triggerRefundExecutorAsync();
    return toAdminRefundDto(retried);
  }

  async getRefundSummaryForBooking(bookingId: string): Promise<BookingRefundSummaryDto | null> {
    const [latest] = await this.db
      .select({
        amountMinor: paymentsRefunds.amountMinor,
        status: paymentsRefunds.status,
      })
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, bookingId))
      .orderBy(desc(paymentsRefunds.createdAt), desc(paymentsRefunds.id))
      .limit(1);

    if (!latest) {
      return null;
    }
    return {
      amountMinor: latest.amountMinor.toString(),
      status: latest.status,
    };
  }
}
