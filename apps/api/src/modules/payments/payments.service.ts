import {
  and,
  type DatabaseClient,
  type DatabaseTransaction,
  desc,
  eq,
  type InboxMessage,
  lte,
  type PaymentAttemptRow,
  paymentsPaymentAttempts,
  sql,
} from '@internationalota/db';
import { type CurrencyCode, createMoney } from '@internationalota/money';
import { resolveAppEnv } from '@internationalota/shared';
import { parseLocalDate } from '@internationalota/time';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  bookingConflictException,
  bookingEmailNotVerifiedException,
  bookingNotFoundException,
  type BookingPaymentSummaryDto,
  type BookingPaymentSummaryPort,
  BookingService,
} from '../booking/index.js';
import { LedgerService } from '../finance/index.js';
import {
  InboxService,
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
  PaymentVerificationResult,
} from './payments.types.js';

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

@Injectable()
export class PaymentsService
  implements OnModuleInit, BookingPaymentSummaryPort, PaymentReconciliationWorkerPort
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
}
