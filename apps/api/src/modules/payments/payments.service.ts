import {
  and,
  type DatabaseClient,
  type DatabaseTransaction,
  desc,
  eq,
  type InboxMessage,
  lte,
  type PaymentAttemptRow,
  paymentsMockPspTransactions,
  paymentsPaymentAttempts,
  paymentsRefunds,
  sql,
} from '@internationalota/db';
import { type CurrencyCode, createMoney } from '@internationalota/money';
import { type ReconciliationFinding, resolveAppEnv } from '@internationalota/shared';
import { parseLocalDate } from '@internationalota/time';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  type BookingAdminPaymentPort,
  bookingConflictException,
  bookingEmailNotVerifiedException,
  bookingNotFoundException,
  type BookingPaymentSummaryDto,
  type BookingPaymentSummaryPort,
  type BookingRefundSummaryDto,
  BookingService,
} from '../booking/index.js';
import { LedgerService } from '../finance/index.js';
import {
  InboxService,
  JobQueueService,
  OutboxService,
  type PaymentReconciliationWorkerPort,
} from '../messaging/index.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { PaymentProviderRegistry } from './payment-provider.registry.js';
import {
  paymentInvalidReturnUrlException,
  paymentNoProviderException,
  paymentProviderUnavailableException,
  paymentTooManyAttemptsException,
} from './payments.errors.js';
import type {
  InitiateCheckoutRequestDto,
  InitiateCheckoutResponseDto,
  LedgerPaymentExpectationPort,
  PaymentCurrencyExpectedTotals,
  PaymentVerificationResult,
  RefundVerificationResult,
} from './payments.types.js';
import { RefundService } from './refund.service.js';

const MAX_ATTEMPTS_PER_BOOKING = 3;
const CHECKOUT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MINUTES = 20;
const DEFAULT_EXPIRE_MINUTES = 60;

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

function validateAndNormalizeReturnUrl(
  rawReturnUrl: string | undefined,
  bookingReference: string,
  locale: string,
): string {
  if (rawReturnUrl === undefined || rawReturnUrl.trim() === '') {
    return `/${locale}/bookings/${bookingReference}`;
  }
  const trimmed = rawReturnUrl.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  const publicBase = process.env['PUBLIC_BASE_URL']?.trim();
  if (publicBase) {
    try {
      const targetUrl = new URL(trimmed);
      const baseOrigin = new URL(publicBase).origin;
      if (targetUrl.origin === baseOrigin) {
        return trimmed;
      }
    } catch {
      throw paymentInvalidReturnUrlException();
    }
  }
  throw paymentInvalidReturnUrlException();
}

function parseVerificationPayload(message: InboxMessage): PaymentVerificationResult {
  const payload = message.payload as Record<string, unknown>;
  const eventId =
    typeof payload['eventId'] === 'string' && payload['eventId'].trim()
      ? payload['eventId'].trim()
      : message.providerEventId;
  const providerRef =
    typeof payload['providerRef'] === 'string' && payload['providerRef'].trim()
      ? payload['providerRef'].trim()
      : '';
  const outcome =
    payload['outcome'] === 'succeeded' || payload['outcome'] === 'failed'
      ? payload['outcome']
      : null;
  const rawAmount = payload['amountMinor'];
  const amountMinor =
    typeof rawAmount === 'string' && /^\d+$/.test(rawAmount)
      ? BigInt(rawAmount)
      : typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount) && rawAmount >= 0
        ? BigInt(rawAmount)
        : null;
  const currency =
    typeof payload['currency'] === 'string' && /^[A-Z]{3}$/.test(payload['currency'].trim())
      ? payload['currency'].trim()
      : null;
  const occurredAt =
    typeof payload['occurredAt'] === 'string' && payload['occurredAt'].trim()
      ? payload['occurredAt'].trim()
      : new Date().toISOString();

  if (!providerRef || !outcome || amountMinor === null || !currency) {
    throw new Error(`Malformed payment webhook payload in inbox for event "${eventId}"`);
  }

  return {
    eventId,
    providerRef,
    outcome,
    amountMinor,
    currency,
    occurredAt,
  };
}

function parseRefundVerificationPayload(message: InboxMessage): RefundVerificationResult {
  const payload = message.payload as Record<string, unknown>;
  const eventId =
    typeof payload['eventId'] === 'string' && payload['eventId'].trim()
      ? payload['eventId'].trim()
      : message.providerEventId;
  const providerRefundRef =
    typeof payload['providerRefundRef'] === 'string' && payload['providerRefundRef'].trim()
      ? payload['providerRefundRef'].trim()
      : '';
  const refundId =
    typeof payload['refundId'] === 'string' && payload['refundId'].trim()
      ? payload['refundId'].trim()
      : undefined;
  const eventType = typeof payload['eventType'] === 'string' ? payload['eventType'].trim() : '';
  const outcome =
    eventType === 'refund.succeeded' || payload['outcome'] === 'succeeded'
      ? 'succeeded'
      : eventType === 'refund.failed' || payload['outcome'] === 'failed'
        ? 'failed'
        : null;
  const rawAmount = payload['amountMinor'];
  const amountMinor =
    typeof rawAmount === 'string' && /^\d+$/.test(rawAmount)
      ? BigInt(rawAmount)
      : typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount) && rawAmount >= 0
        ? BigInt(rawAmount)
        : null;
  const currency =
    typeof payload['currency'] === 'string' && /^[A-Z]{3}$/.test(payload['currency'].trim())
      ? payload['currency'].trim()
      : null;
  const occurredAt =
    typeof payload['occurredAt'] === 'string' && payload['occurredAt'].trim()
      ? payload['occurredAt'].trim()
      : new Date().toISOString();

  if (!providerRefundRef || !outcome || amountMinor === null || !currency) {
    throw new Error(`Malformed refund webhook payload in inbox for event "${eventId}"`);
  }

  return {
    eventId,
    providerRefundRef,
    ...(refundId ? { refundId } : {}),
    outcome,
    amountMinor,
    currency,
    occurredAt,
  };
}

@Injectable()
export class PaymentsService
  implements
    OnModuleInit,
    BookingPaymentSummaryPort,
    PaymentReconciliationWorkerPort,
    LedgerPaymentExpectationPort,
    BookingAdminPaymentPort
{
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly bookingService: BookingService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly inboxService: InboxService,
    private readonly registry: PaymentProviderRegistry,
    private readonly mockProvider: MockPaymentProvider,
    private readonly refundService: RefundService,
    @Optional() private readonly jobQueueService?: JobQueueService,
  ) {}

  onModuleInit(): void {
    this.syncProviderRegistrations();
  }

  syncProviderRegistrations(): void {
    const appEnv = resolveAppEnv();
    if (this.mockProvider.isAvailable()) {
      this.registry.register(this.mockProvider);
      this.inboxService.registerVerifier(this.mockProvider);
      this.inboxService.registerVerifierAlias(
        this.mockProvider.webhookSlug,
        this.mockProvider.provider,
      );
      this.inboxService.registerHandler(this.mockProvider.provider, async (msg, tx) => {
        await this.handleProviderInboxMessage(msg, tx);
      });
    } else {
      this.registry.unregister(this.mockProvider.provider);
      this.logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'mock_payment_provider_not_registered',
          appEnv,
          reason:
            appEnv === 'production' ? 'disabled_in_production' : 'missing_or_short_MOCK_PSP_SECRET',
        }),
      );
    }
  }

  async initiateCheckout(
    rawReference: string,
    customerUserId: string,
    input?: InitiateCheckoutRequestDto,
  ): Promise<InitiateCheckoutResponseDto> {
    const provider = this.registry.get(input?.provider);
    if (!provider) {
      throw paymentNoProviderException();
    }

    // Tx1: lock booking row, enforce ownership + D-018 + DB expiry clock + < 3 attempts, mark payment_pending, create attempt
    const tx1Result = await this.db.transaction(async (tx) => {
      const prep = await this.bookingService.prepareForCheckout(rawReference, customerUserId, tx);
      if (!prep.ok) {
        if (prep.reason === 'not_found') {
          throw bookingNotFoundException();
        }
        if (prep.reason === 'email_not_verified') {
          throw bookingEmailNotVerifiedException();
        }
        throw bookingConflictException();
      }

      const booking = prep.booking;
      const returnUrl = validateAndNormalizeReturnUrl(
        input?.returnUrl,
        booking.reference,
        booking.contactLocale,
      );

      const countRes = await tx.execute<{ cnt: number }>(
        sql`SELECT COUNT(*)::int AS cnt FROM payments.payment_attempts WHERE booking_id = ${booking.id}`,
      );
      const attemptCount = countRes.rows[0]?.cnt ?? 0;
      if (attemptCount >= MAX_ATTEMPTS_PER_BOOKING) {
        throw paymentTooManyAttemptsException(MAX_ATTEMPTS_PER_BOOKING);
      }

      const [attempt] = await tx
        .insert(paymentsPaymentAttempts)
        .values({
          bookingId: booking.id,
          provider: provider.provider,
          providerRef: null,
          amountMinor: BigInt(booking.totalAmountMinor),
          currency: booking.currency,
          providerConfigSnapshot: provider.getConfigSnapshot(),
          status: 'initiated',
          version: 1,
        })
        .returning();

      if (!attempt) {
        throw new Error('Failed to insert payment attempt');
      }

      return { attempt, booking, returnUrl };
    });

    // External provider call OUTSIDE any DB transaction (10s timeout)
    let checkoutOutput: { providerRef: string; redirectUrl: string };
    try {
      checkoutOutput = await withTimeout(
        provider.createCheckout({
          attemptId: tx1Result.attempt.id,
          bookingReference: tx1Result.booking.reference,
          amountMinor: tx1Result.attempt.amountMinor,
          currency: tx1Result.attempt.currency.trim(),
          locale: tx1Result.booking.contactLocale,
          returnUrl: tx1Result.returnUrl,
        }),
        CHECKOUT_TIMEOUT_MS,
        `${provider.provider}.createCheckout`,
      );
    } catch (err: unknown) {
      await this.failInitiatedAttemptOnProviderError(
        tx1Result.attempt.id,
        tx1Result.booking.id,
        err instanceof Error ? err.message : String(err),
      );
      throw paymentProviderUnavailableException();
    }

    // Tx2: persist provider_ref + enqueue outbox payment.initiated
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(paymentsPaymentAttempts)
        .set({
          providerRef: checkoutOutput.providerRef,
          version: tx1Result.attempt.version + 1,
        })
        .where(
          and(
            eq(paymentsPaymentAttempts.id, tx1Result.attempt.id),
            eq(paymentsPaymentAttempts.version, tx1Result.attempt.version),
          ),
        )
        .returning();

      if (!updated) {
        throw new Error(
          `Concurrent update while storing providerRef for attempt ${tx1Result.attempt.id}`,
        );
      }

      await this.outboxService.enqueue(tx, {
        aggregateType: 'payment_attempt',
        aggregateId: updated.id,
        eventType: 'payment.initiated',
        payload: {
          attemptId: updated.id,
          bookingId: updated.bookingId,
          provider: updated.provider,
          providerRef: updated.providerRef,
          amountMinor: updated.amountMinor.toString(),
          currency: updated.currency.trim(),
        },
      });
    });

    return {
      attemptId: tx1Result.attempt.id,
      provider: provider.provider,
      providerRef: checkoutOutput.providerRef,
      redirectUrl: checkoutOutput.redirectUrl,
    };
  }

  private async failInitiatedAttemptOnProviderError(
    attemptId: string,
    bookingId: string,
    errorDetail: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(paymentsPaymentAttempts)
        .where(eq(paymentsPaymentAttempts.id, attemptId))
        .for('update');

      if (!locked || locked.status !== 'initiated') {
        return;
      }

      const [updated] = await tx
        .update(paymentsPaymentAttempts)
        .set({
          status: 'failed',
          failureReason: 'provider_unavailable',
          completedAt: sql`now()`,
          version: locked.version + 1,
        })
        .where(
          and(
            eq(paymentsPaymentAttempts.id, locked.id),
            eq(paymentsPaymentAttempts.version, locked.version),
          ),
        )
        .returning();

      if (updated) {
        await this.outboxService.enqueue(tx, {
          aggregateType: 'payment_attempt',
          aggregateId: updated.id,
          eventType: 'payment.failed',
          payload: {
            attemptId: updated.id,
            bookingId,
            provider: updated.provider,
            failureReason: 'provider_unavailable',
          },
        });
      }
    });

    this.logger.warn(
      JSON.stringify({
        level: 'warn',
        event: 'checkout_provider_unavailable',
        attemptId,
        bookingId,
        message: errorDetail,
      }),
    );
  }

  async handleProviderInboxMessage(message: InboxMessage, tx: DatabaseTransaction): Promise<void> {
    const rawPayload = message.payload as Record<string, unknown>;
    const eventType =
      typeof rawPayload['eventType'] === 'string' ? rawPayload['eventType'].trim() : '';

    if (eventType === 'refund.succeeded' || eventType === 'refund.failed') {
      const refundVerification = parseRefundVerificationPayload(message);
      await this.refundService.handleRefundWebhook(tx, message.provider, refundVerification);
      return;
    }

    const verification = parseVerificationPayload(message);
    await this.processVerifiedOutcomeByProviderRef(tx, message.provider, verification, 'webhook');
  }

  async processVerifiedOutcomeByProviderRef(
    tx: DatabaseTransaction,
    provider: string,
    verification: PaymentVerificationResult,
    source: 'webhook' | 'reconciliation',
  ): Promise<'processed' | 'noop'> {
    // 1. Lock the attempt FOR UPDATE first (strict topological lock order: attempt -> booking)
    const [attempt] = await tx
      .select()
      .from(paymentsPaymentAttempts)
      .where(
        and(
          eq(paymentsPaymentAttempts.provider, provider),
          eq(paymentsPaymentAttempts.providerRef, verification.providerRef),
        ),
      )
      .for('update');

    if (!attempt) {
      throw new Error(
        `Payment attempt not found for provider="${provider}" providerRef="${verification.providerRef}"`,
      );
    }

    return this.processLockedAttemptOutcome(tx, attempt, verification, source);
  }

  private async processLockedAttemptOutcome(
    tx: DatabaseTransaction,
    attempt: PaymentAttemptRow,
    verification: PaymentVerificationResult,
    source: 'webhook' | 'reconciliation',
  ): Promise<'processed' | 'noop'> {
    if (attempt.status !== 'initiated') {
      this.logger.log(
        JSON.stringify({
          level: 'info',
          event: 'payment_callback_already_terminal',
          attemptId: attempt.id,
          bookingId: attempt.bookingId,
          currentStatus: attempt.status,
          eventId: verification.eventId,
          source,
        }),
      );
      return 'noop';
    }

    const attemptCurrency = attempt.currency.trim();

    // 2. Verify amount & currency match the initiated attempt
    if (
      verification.amountMinor !== attempt.amountMinor ||
      verification.currency !== attemptCurrency
    ) {
      await tx
        .update(paymentsPaymentAttempts)
        .set({
          status: 'failed',
          failureReason: 'amount_mismatch',
          completedAt: sql`now()`,
          version: attempt.version + 1,
        })
        .where(
          and(
            eq(paymentsPaymentAttempts.id, attempt.id),
            eq(paymentsPaymentAttempts.version, attempt.version),
          ),
        );

      await this.outboxService.enqueue(tx, {
        aggregateType: 'payment_attempt',
        aggregateId: attempt.id,
        eventType: 'payment.amount_mismatch',
        payload: {
          attemptId: attempt.id,
          bookingId: attempt.bookingId,
          provider: attempt.provider,
          providerRef: verification.providerRef,
          expectedAmountMinor: attempt.amountMinor.toString(),
          expectedCurrency: attemptCurrency,
          receivedAmountMinor: verification.amountMinor.toString(),
          receivedCurrency: verification.currency,
        },
      });

      this.logger.error(
        JSON.stringify({
          level: 'error',
          event: 'payment_amount_mismatch',
          attemptId: attempt.id,
          bookingId: attempt.bookingId,
          provider: attempt.provider,
          expectedAmountMinor: attempt.amountMinor.toString(),
          receivedAmountMinor: verification.amountMinor.toString(),
          expectedCurrency: attemptCurrency,
          receivedCurrency: verification.currency,
        }),
      );

      return 'processed';
    }

    // 3. Provider reported failure -> attempt failed, booking stays untouched
    if (verification.outcome === 'failed') {
      await tx
        .update(paymentsPaymentAttempts)
        .set({
          status: 'failed',
          failureReason: 'provider_failed',
          completedAt: sql`now()`,
          version: attempt.version + 1,
        })
        .where(
          and(
            eq(paymentsPaymentAttempts.id, attempt.id),
            eq(paymentsPaymentAttempts.version, attempt.version),
          ),
        );

      await this.outboxService.enqueue(tx, {
        aggregateType: 'payment_attempt',
        aggregateId: attempt.id,
        eventType: 'payment.failed',
        payload: {
          attemptId: attempt.id,
          bookingId: attempt.bookingId,
          provider: attempt.provider,
          providerRef: verification.providerRef,
          failureReason: 'provider_failed',
        },
      });

      return 'processed';
    }

    // 4. Provider reported success -> confirm booking inside SAME transaction via BookingService
    const confirmRes = await this.bookingService.confirm(
      attempt.bookingId,
      verification.providerRef,
      { tx },
    );

    const effectiveDate = parseLocalDate(new Date().toISOString().slice(0, 10));
    const amountMoney = createMoney(attempt.amountMinor, attemptCurrency as CurrencyCode);
    const clearingAccount = await this.ledgerService.ensureAccount(tx, {
      code: `asset:psp_clearing:${attempt.provider}:${attemptCurrency}`,
      name: `PSP Clearing (${attempt.provider} ${attemptCurrency})`,
      type: 'asset',
      currency: attemptCurrency as CurrencyCode,
    });

    if (confirmRes.ok) {
      await tx
        .update(paymentsPaymentAttempts)
        .set({
          status: 'succeeded',
          completedAt: sql`now()`,
          version: attempt.version + 1,
        })
        .where(
          and(
            eq(paymentsPaymentAttempts.id, attempt.id),
            eq(paymentsPaymentAttempts.version, attempt.version),
          ),
        );

      const prepaymentsAccount = await this.ledgerService.ensureAccount(tx, {
        code: `liability:customer_prepayments:${attemptCurrency}`,
        name: `Customer Prepayments (${attemptCurrency})`,
        type: 'liability',
        currency: attemptCurrency as CurrencyCode,
      });

      await this.ledgerService.post(tx, {
        effectiveDate,
        description: `Payment captured for booking ${confirmRes.booking.reference} (${attempt.provider})`,
        sourceType: 'payment_attempt',
        sourceId: attempt.id,
        entryKind: 'payment_capture',
        lines: [
          {
            accountId: clearingAccount.id,
            side: 'debit',
            amount: amountMoney,
            memo: verification.providerRef,
          },
          {
            accountId: prepaymentsAccount.id,
            side: 'credit',
            amount: amountMoney,
            memo: confirmRes.booking.reference,
          },
        ],
      });

      await this.outboxService.enqueue(tx, {
        aggregateType: 'payment_attempt',
        aggregateId: attempt.id,
        eventType: 'payment.succeeded',
        payload: {
          attemptId: attempt.id,
          bookingId: attempt.bookingId,
          bookingReference: confirmRes.booking.reference,
          provider: attempt.provider,
          providerRef: verification.providerRef,
          amountMinor: attempt.amountMinor.toString(),
          currency: attemptCurrency,
          source,
        },
      });

      return 'processed';
    }

    // not_confirmable (expired/cancelled) or conflict (already confirmed by another attempt)
    const refundReason =
      confirmRes.reason === 'conflict' ? 'double_payment' : 'booking_not_confirmable';

    await tx
      .update(paymentsPaymentAttempts)
      .set({
        status: 'refund_required',
        failureReason: refundReason,
        completedAt: sql`now()`,
        version: attempt.version + 1,
      })
      .where(
        and(
          eq(paymentsPaymentAttempts.id, attempt.id),
          eq(paymentsPaymentAttempts.version, attempt.version),
        ),
      );

    const refundsPayableAccount = await this.ledgerService.ensureAccount(tx, {
      code: `liability:refunds_payable:${attemptCurrency}`,
      name: `Refunds Payable (${attemptCurrency})`,
      type: 'liability',
      currency: attemptCurrency as CurrencyCode,
    });

    await this.ledgerService.post(tx, {
      effectiveDate,
      description: `Late or duplicate capture requiring refund for booking ${attempt.bookingId}`,
      sourceType: 'payment_attempt',
      sourceId: attempt.id,
      entryKind: 'payment_refund_required',
      lines: [
        {
          accountId: clearingAccount.id,
          side: 'debit',
          amount: amountMoney,
          memo: verification.providerRef,
        },
        {
          accountId: refundsPayableAccount.id,
          side: 'credit',
          amount: amountMoney,
          memo: refundReason,
        },
      ],
    });

    await this.outboxService.enqueue(tx, {
      aggregateType: 'payment_attempt',
      aggregateId: attempt.id,
      eventType: 'payment.refund_required',
      payload: {
        attemptId: attempt.id,
        bookingId: attempt.bookingId,
        provider: attempt.provider,
        providerRef: verification.providerRef,
        reason: refundReason,
        amountMinor: attempt.amountMinor.toString(),
        currency: attemptCurrency,
        source,
      },
    });

    this.jobQueueService?.triggerOutboxRelayAsync();

    return 'processed';
  }

  async reconcilePending(options?: {
    readonly staleAfterMinutes?: number;
    readonly expireAfterMinutes?: number;
  }): Promise<{
    readonly checkedCount: number;
    readonly resolvedCount: number;
    readonly expiredCount: number;
  }> {
    const staleMinutes = options?.staleAfterMinutes ?? DEFAULT_STALE_MINUTES;
    const expireMinutes = options?.expireAfterMinutes ?? DEFAULT_EXPIRE_MINUTES;

    const candidates = await this.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(
        and(
          eq(paymentsPaymentAttempts.status, 'initiated'),
          lte(
            paymentsPaymentAttempts.createdAt,
            sql`now() - (${staleMinutes} * interval '1 minute')`,
          ),
        ),
      );

    let checkedCount = 0;
    let resolvedCount = 0;
    let expiredCount = 0;

    for (const candidate of candidates) {
      checkedCount += 1;

      if (!candidate.providerRef) {
        const didExpire = await this.expireAttemptIfOlderThan(candidate.id, expireMinutes);
        if (didExpire) {
          expiredCount += 1;
        }
        continue;
      }

      const provider = this.registry.get(candidate.provider);
      if (!provider) {
        continue;
      }

      let remoteStatus: PaymentVerificationResult | 'pending';
      try {
        remoteStatus = await withTimeout(
          provider.getStatus(candidate.providerRef),
          CHECKOUT_TIMEOUT_MS,
          `${provider.provider}.getStatus`,
        );
      } catch (err: unknown) {
        this.logger.warn(
          JSON.stringify({
            level: 'warn',
            event: 'reconciliation_get_status_failed',
            attemptId: candidate.id,
            provider: candidate.provider,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        continue;
      }

      if (remoteStatus === 'pending') {
        const didExpire = await this.expireAttemptIfOlderThan(candidate.id, expireMinutes);
        if (didExpire) {
          expiredCount += 1;
        }
        continue;
      }

      const outcome = await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(paymentsPaymentAttempts)
          .where(eq(paymentsPaymentAttempts.id, candidate.id))
          .for('update');
        if (!locked) {
          return 'noop' as const;
        }
        return this.processLockedAttemptOutcome(tx, locked, remoteStatus, 'reconciliation');
      });

      if (outcome === 'processed') {
        resolvedCount += 1;
      }
    }

    return { checkedCount, resolvedCount, expiredCount };
  }

  private async expireAttemptIfOlderThan(
    attemptId: string,
    expireAfterMinutes: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(paymentsPaymentAttempts)
        .where(
          and(
            eq(paymentsPaymentAttempts.id, attemptId),
            eq(paymentsPaymentAttempts.status, 'initiated'),
            lte(
              paymentsPaymentAttempts.createdAt,
              sql`now() - (${expireAfterMinutes} * interval '1 minute')`,
            ),
          ),
        )
        .for('update');

      if (!locked) {
        return false;
      }

      const [updated] = await tx
        .update(paymentsPaymentAttempts)
        .set({
          status: 'expired',
          completedAt: sql`now()`,
          version: locked.version + 1,
        })
        .where(
          and(
            eq(paymentsPaymentAttempts.id, locked.id),
            eq(paymentsPaymentAttempts.version, locked.version),
          ),
        )
        .returning();

      if (!updated) {
        return false;
      }

      await this.outboxService.enqueue(tx, {
        aggregateType: 'payment_attempt',
        aggregateId: updated.id,
        eventType: 'payment.expired',
        payload: {
          attemptId: updated.id,
          bookingId: updated.bookingId,
          provider: updated.provider,
          providerRef: updated.providerRef,
        },
      });

      return true;
    });
  }

  async getPaymentSummaryForBooking(bookingId: string): Promise<BookingPaymentSummaryDto> {
    const rows = await this.db
      .select({ status: paymentsPaymentAttempts.status })
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.bookingId, bookingId))
      .orderBy(desc(paymentsPaymentAttempts.createdAt), desc(paymentsPaymentAttempts.id));

    return {
      status: rows[0]?.status ?? null,
      attemptCount: rows.length,
    };
  }

  async getRefundSummaryForBooking(bookingId: string): Promise<BookingRefundSummaryDto | null> {
    return this.refundService.getRefundSummaryForBooking(bookingId);
  }

  async getAdminBookingRecords(bookingId: string) {
    const attemptRows = await this.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.bookingId, bookingId))
      .orderBy(desc(paymentsPaymentAttempts.createdAt), desc(paymentsPaymentAttempts.id));

    const refundRows = await this.db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, bookingId))
      .orderBy(desc(paymentsRefunds.createdAt), desc(paymentsRefunds.id));

    return {
      attempts: attemptRows.map((row) => ({
        id: row.id,
        provider: row.provider,
        providerRef: row.providerRef,
        amountMinor: row.amountMinor.toString(),
        currency: row.currency.trim(),
        status: row.status,
        failureReason: row.failureReason,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      })),
      refunds: refundRows.map((row) => ({
        id: row.id,
        paymentAttemptId: row.paymentAttemptId,
        provider: row.provider,
        amountMinor: row.amountMinor.toString(),
        currency: row.currency.trim(),
        reason: row.reason,
        status: row.status,
        providerRefundRef: row.providerRefundRef,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      })),
    };
  }

  /**
   * Read-only port method for Finance reconciliation: per-currency expected totals as of `asOf`.
   */
  async getPaymentLedgerExpectedTotalsByCurrency(
    asOf: Date,
  ): Promise<ReadonlyMap<string, PaymentCurrencyExpectedTotals>> {
    const capturedRes = await this.db.execute(sql`
      SELECT TRIM(currency) AS currency, COALESCE(SUM(amount_minor), 0)::text AS total
      FROM payments.payment_attempts
      WHERE status IN ('succeeded', 'refund_required')
        AND (completed_at IS NULL OR completed_at <= ${asOf})
      GROUP BY TRIM(currency)
    `);

    const settledRefundsRes = await this.db.execute(sql`
      SELECT TRIM(currency) AS currency, COALESCE(SUM(amount_minor), 0)::text AS total
      FROM payments.refunds
      WHERE status = 'succeeded'
        AND completed_at IS NOT NULL
        AND completed_at <= ${asOf}
      GROUP BY TRIM(currency)
    `);

    const openRefundsRes = await this.db.execute(sql`
      SELECT TRIM(currency) AS currency, COALESCE(SUM(amount_minor), 0)::text AS total
      FROM payments.refunds
      WHERE status IN ('requested', 'processing', 'failed', 'manual_review')
        AND created_at <= ${asOf}
      GROUP BY TRIM(currency)
    `);

    const unrefundedRes = await this.db.execute(sql`
      SELECT TRIM(a.currency) AS currency, COALESCE(SUM(a.amount_minor), 0)::text AS total
      FROM payments.payment_attempts a
      WHERE a.status = 'refund_required'
        AND (a.completed_at IS NULL OR a.completed_at <= ${asOf})
        AND NOT EXISTS (
          SELECT 1 FROM payments.refunds r
          WHERE r.payment_attempt_id = a.id
            AND r.created_at <= ${asOf}
        )
      GROUP BY TRIM(a.currency)
    `);

    const acc = new Map<
      string,
      {
        capturedMinor: bigint;
        settledRefundsMinor: bigint;
        openRefundsMinor: bigint;
        unrefundedRefundRequiredMinor: bigint;
      }
    >();

    const ensure = (currency: string) => {
      let entry = acc.get(currency);
      if (!entry) {
        entry = {
          capturedMinor: 0n,
          settledRefundsMinor: 0n,
          openRefundsMinor: 0n,
          unrefundedRefundRequiredMinor: 0n,
        };
        acc.set(currency, entry);
      }
      return entry;
    };

    for (const row of capturedRes.rows) {
      ensure(String(row['currency'])).capturedMinor = BigInt(String(row['total']));
    }
    for (const row of settledRefundsRes.rows) {
      ensure(String(row['currency'])).settledRefundsMinor = BigInt(String(row['total']));
    }
    for (const row of openRefundsRes.rows) {
      ensure(String(row['currency'])).openRefundsMinor = BigInt(String(row['total']));
    }
    for (const row of unrefundedRes.rows) {
      ensure(String(row['currency'])).unrefundedRefundRequiredMinor = BigInt(String(row['total']));
    }

    return acc;
  }

  /**
   * Read-only reconciliation checks owned by Payments:
   * - Check 2: Booking <-> payment_attempts & refund_required coverage
   * - Check 3: Payment attempts <-> mock_psp_transactions settlement
   * - Check 5: Stuck initiated attempts (>60 min) & manual_review refunds (warnings)
   */
  async runReconciliationChecks(asOf: Date): Promise<readonly ReconciliationFinding[]> {
    const findings: ReconciliationFinding[] = [];
    const bookings = await this.bookingService.getBookingReconciliationSnapshots(asOf);
    const bookingsById = new Map(bookings.map((b) => [b.id, b]));

    const attempts = await this.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(lte(paymentsPaymentAttempts.createdAt, asOf));

    const refunds = await this.db
      .select()
      .from(paymentsRefunds)
      .where(lte(paymentsRefunds.createdAt, asOf));

    const mockTxs = await this.db.select().from(paymentsMockPspTransactions);

    const attemptsById = new Map(attempts.map((a) => [a.id, a]));
    const succeededByBooking = new Map<string, PaymentAttemptRow[]>();
    const refundAttemptIds = new Set(refunds.map((r) => r.paymentAttemptId));

    for (const attempt of attempts) {
      if (attempt.status === 'succeeded') {
        const list = succeededByBooking.get(attempt.bookingId) ?? [];
        list.push(attempt);
        succeededByBooking.set(attempt.bookingId, list);
      }
    }

    // Check 2a: every confirmed booking has 1 matching succeeded attempt
    for (const booking of bookings) {
      if (booking.status !== 'confirmed') {
        continue;
      }
      const matching = succeededByBooking.get(booking.id) ?? [];
      if (matching.length === 0) {
        findings.push({
          code: 'BOOKING_CONFIRMED_MISSING_SUCCEEDED_ATTEMPT',
          severity: 'error',
          entityType: 'booking',
          entityId: booking.id,
          details: { reference: booking.reference },
        });
        continue;
      }
      if (matching.length > 1) {
        findings.push({
          code: 'BOOKING_CONFIRMED_MULTIPLE_SUCCEEDED_ATTEMPTS',
          severity: 'error',
          entityType: 'booking',
          entityId: booking.id,
          details: { reference: booking.reference, attemptCount: matching.length },
        });
        continue;
      }

      const attempt = matching[0]!;
      if (attempt.amountMinor !== booking.totalAmountMinor) {
        findings.push({
          code: 'PAYMENT_AMOUNT_MISMATCH',
          severity: 'error',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          details: {
            bookingId: booking.id,
            reference: booking.reference,
            bookingAmountMinor: booking.totalAmountMinor.toString(),
            attemptAmountMinor: attempt.amountMinor.toString(),
          },
        });
      }
      if (attempt.currency.trim() !== booking.currency.trim()) {
        findings.push({
          code: 'PAYMENT_CURRENCY_MISMATCH',
          severity: 'error',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          details: {
            bookingId: booking.id,
            reference: booking.reference,
            bookingCurrency: booking.currency.trim(),
            attemptCurrency: attempt.currency.trim(),
          },
        });
      }
      if (booking.paymentRef !== attempt.providerRef) {
        findings.push({
          code: 'BOOKING_PAYMENT_REF_MISMATCH',
          severity: 'error',
          entityType: 'booking',
          entityId: booking.id,
          details: {
            reference: booking.reference,
            bookingPaymentRef: booking.paymentRef,
            attemptProviderRef: attempt.providerRef,
          },
        });
      }
    }

    // Check 2b & 2c & Check 5 initiated attempts
    const staleThresholdMs = asOf.getTime() - 60 * 60_000;
    for (const attempt of attempts) {
      const attemptBooking = bookingsById.get(attempt.bookingId);
      if (attempt.status === 'succeeded') {
        if (
          !attemptBooking ||
          (attemptBooking.status !== 'confirmed' && attemptBooking.status !== 'cancelled')
        ) {
          findings.push({
            code: 'PAYMENT_SUCCEEDED_INVALID_BOOKING_STATUS',
            severity: 'error',
            entityType: 'payment_attempt',
            entityId: attempt.id,
            details: {
              bookingId: attempt.bookingId,
              ...(attemptBooking ? { reference: attemptBooking.reference } : {}),
              bookingStatus: attemptBooking?.status ?? 'missing',
            },
          });
        }
      } else if (attempt.status === 'refund_required' && !refundAttemptIds.has(attempt.id)) {
        findings.push({
          code: 'PAYMENT_REFUND_REQUIRED_MISSING_REFUND',
          severity: 'error',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          details: {
            bookingId: attempt.bookingId,
            ...(attemptBooking ? { reference: attemptBooking.reference } : {}),
          },
        });
      } else if (attempt.status === 'initiated' && attempt.createdAt.getTime() < staleThresholdMs) {
        findings.push({
          code: 'PAYMENT_STUCK_INITIATED',
          severity: 'warning',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          details: {
            bookingId: attempt.bookingId,
            ...(attemptBooking ? { reference: attemptBooking.reference } : {}),
            createdAt: attempt.createdAt.toISOString(),
          },
        });
      }
    }

    // Check 3: Mock PSP settlement <-> payment attempts
    const mockTxByAttemptId = new Map(mockTxs.map((tx) => [tx.attemptId, tx]));
    for (const tx of mockTxs) {
      if (tx.status !== 'succeeded') {
        continue;
      }
      const txTimestamp = tx.occurredAt ?? tx.updatedAt;
      if (txTimestamp.getTime() > asOf.getTime()) {
        continue;
      }
      const attempt = attemptsById.get(tx.attemptId);
      if (!attempt || (attempt.status !== 'succeeded' && attempt.status !== 'refund_required')) {
        findings.push({
          code: 'PSP_SETTLEMENT_MISSING_ATTEMPT',
          severity: 'error',
          entityType: 'mock_psp_transaction',
          entityId: tx.id,
          details: {
            attemptId: tx.attemptId,
            providerRef: tx.providerRef,
            attemptStatus: attempt?.status ?? 'missing',
          },
        });
        continue;
      }
      if (
        tx.amountMinor !== attempt.amountMinor ||
        tx.currency.trim() !== attempt.currency.trim()
      ) {
        findings.push({
          code: 'PSP_SETTLEMENT_AMOUNT_MISMATCH',
          severity: 'error',
          entityType: 'mock_psp_transaction',
          entityId: tx.id,
          details: {
            attemptId: attempt.id,
            pspAmountMinor: tx.amountMinor.toString(),
            attemptAmountMinor: attempt.amountMinor.toString(),
            pspCurrency: tx.currency.trim(),
            attemptCurrency: attempt.currency.trim(),
          },
        });
      }
    }

    for (const attempt of attempts) {
      if (
        attempt.provider !== 'mock' ||
        (attempt.status !== 'succeeded' && attempt.status !== 'refund_required')
      ) {
        continue;
      }
      if (attempt.completedAt && attempt.completedAt.getTime() > asOf.getTime()) {
        continue;
      }
      const mockTx = mockTxByAttemptId.get(attempt.id);
      if (
        !mockTx ||
        mockTx.status !== 'succeeded' ||
        mockTx.amountMinor !== attempt.amountMinor ||
        mockTx.currency.trim() !== attempt.currency.trim()
      ) {
        findings.push({
          code: 'ATTEMPT_MISSING_PSP_SETTLEMENT',
          severity: 'error',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          details: {
            providerRef: attempt.providerRef,
            mockTxStatus: mockTx?.status ?? 'missing',
          },
        });
      }
    }

    // Check 5: refunds in manual_review
    for (const refund of refunds) {
      if (refund.status === 'manual_review') {
        const refundBooking = bookingsById.get(refund.bookingId);
        findings.push({
          code: 'REFUND_MANUAL_REVIEW',
          severity: 'warning',
          entityType: 'refund',
          entityId: refund.id,
          details: {
            bookingId: refund.bookingId,
            ...(refundBooking ? { reference: refundBooking.reference } : {}),
            amountMinor: refund.amountMinor.toString(),
            currency: refund.currency.trim(),
            reason: refund.reason,
          },
        });
      }
    }

    return findings;
  }
}
