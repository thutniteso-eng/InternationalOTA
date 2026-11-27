import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  type DatabaseClient,
  type DatabaseTransaction,
  type EmailTemplate,
  eq,
  inArray,
  lte,
  notificationsEmailMessages,
  type OutboxEvent,
  sql,
} from '@internationalota/db';
import type { CurrencyCode } from '@internationalota/money';
import { resolveAppEnv } from '@internationalota/shared';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { BookingService } from '../booking/index.js';
import { CatalogService } from '../catalog/index.js';
import { EMAIL_SENDER, type EmailSender } from '../identity/index.js';
import {
  calculateExponentialBackoffMs,
  JobQueueService,
  type NotificationEmailSenderWorkerPort,
  OutboxService,
} from '../messaging/index.js';
import { EmailTemplateRenderer, resolveEmailLocale } from './email-renderer.service.js';
import { hashRecipientEmail, redactEmailAddresses } from './email-transport.js';
import { NotificationsEmailSender } from './notifications-email-sender.service.js';
import {
  EMAIL_TRANSPORT,
  type EmailDeliverySummary,
  type EmailTransport,
} from './notifications.types.js';

const MAX_EMAIL_ATTEMPTS = 5;
const EMAIL_BASE_BACKOFF_MS = 1000;
const EMAIL_BATCH_LIMIT = 50;
const CLAIM_LEASE_SECONDS = 120;

interface ClaimedEmailMessage {
  readonly id: string;
  readonly eventId: string;
  readonly template: EmailTemplate;
  readonly bookingId: string | null;
  readonly recipientHash: string;
  readonly locale: string;
  readonly attempts: number;
  readonly version: number;
}

@Injectable()
export class NotificationsService implements OnModuleInit, NotificationEmailSenderWorkerPort {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly bookingIdByEmailId = new Map<string, string>();
  private readonly refundPayloadByEmailId = new Map<
    string,
    { readonly bookingId: string; readonly amountMinor: bigint; readonly currency: CurrencyCode }
  >();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
    private readonly renderer: EmailTemplateRenderer,
    private readonly notificationsEmailSender: NotificationsEmailSender,
    private readonly bookingService: BookingService,
    private readonly catalogService: CatalogService,
    private readonly outboxService: OutboxService,
    @Optional() @Inject(EMAIL_SENDER) private readonly identityEmailSender?: EmailSender,
    @Optional() private readonly jobQueueService?: JobQueueService,
  ) {}

  onModuleInit(): void {
    if (resolveAppEnv() === 'production' && this.transport.isLogTransport) {
      throw new Error(
        'Refusing to start in production (APP_ENV=production): LogEmailTransport cannot be used; complete SMTP configuration is required.',
      );
    }

    const bridge = this.identityEmailSender as
      (EmailSender & { setDelegate?: (sender: EmailSender) => void }) | undefined;
    bridge?.setDelegate?.(this.notificationsEmailSender);

    this.outboxService.registerHandler('booking.held', async (event, tx) => {
      await this.handleBookingEvent('booking_held', event, tx);
    });
    this.outboxService.registerHandler('booking.confirmed', async (event, tx) => {
      await this.handleBookingEvent('booking_confirmed', event, tx);
    });
    this.outboxService.registerHandler('booking.expired', async (event, tx) => {
      await this.handleBookingEvent('booking_expired', event, tx);
    });
    this.outboxService.registerHandler('booking.cancelled', async (event, tx) => {
      await this.handleBookingEvent('booking_cancelled', event, tx);
    });
    this.outboxService.registerHandler('refund.succeeded', async (event, tx) => {
      await this.handleRefundSucceededEvent(event, tx);
    });
  }

  /**
   * Queues a single email row keyed cleanly by `(event_id, template)`.
   * Duplicate deliveries hit `ON CONFLICT DO NOTHING` and return without sending.
   */
  async handleBookingEvent(
    template: Exclude<EmailTemplate, 'refund_succeeded'>,
    event: OutboxEvent,
    tx?: DatabaseTransaction,
  ): Promise<string | null> {
    const payload =
      typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    const bookingId =
      typeof payload['bookingId'] === 'string' ? payload['bookingId'] : event.aggregateId;

    const ctx = await this.bookingService.getNotificationBookingById(bookingId);
    if (!ctx) {
      this.logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'notification_booking_not_found',
          eventId: event.id,
          bookingId,
          template,
        }),
      );
      return null;
    }

    const locale = resolveEmailLocale(ctx.booking.contactLocale);
    const recipientHash = hashRecipientEmail(ctx.booking.contactEmail);

    const executor = tx ?? this.db;
    const [inserted] = await executor
      .insert(notificationsEmailMessages)
      .values({
        id: randomUUID(),
        eventId: event.id,
        template,
        recipientHash,
        locale,
        status: 'queued',
        attempts: 0,
        version: 1,
      })
      .onConflictDoNothing({
        target: [notificationsEmailMessages.eventId, notificationsEmailMessages.template],
      })
      .returning({ id: notificationsEmailMessages.id });

    if (!inserted) {
      return null;
    }

    this.bookingIdByEmailId.set(inserted.id, bookingId);
    this.jobQueueService?.triggerNotificationSenderAsync();
    return inserted.id;
  }

  async handleRefundSucceededEvent(
    event: OutboxEvent,
    tx?: DatabaseTransaction,
  ): Promise<string | null> {
    const payload =
      typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    const bookingId = typeof payload['bookingId'] === 'string' ? payload['bookingId'] : '';
    const amountMinorRaw =
      typeof payload['amountMinor'] === 'string' ? payload['amountMinor'] : '0';
    const currencyRaw = typeof payload['currency'] === 'string' ? payload['currency'] : 'VND';

    if (!bookingId) {
      return null;
    }

    const ctx = await this.bookingService.getNotificationBookingById(bookingId);
    if (!ctx) {
      this.logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'notification_refund_booking_not_found',
          eventId: event.id,
          bookingId,
        }),
      );
      return null;
    }

    const locale = resolveEmailLocale(ctx.booking.contactLocale);
    const recipientHash = hashRecipientEmail(ctx.booking.contactEmail);

    const executor = tx ?? this.db;
    const [inserted] = await executor
      .insert(notificationsEmailMessages)
      .values({
        id: randomUUID(),
        eventId: event.id,
        template: 'refund_succeeded',
        recipientHash,
        locale,
        status: 'queued',
        attempts: 0,
        version: 1,
      })
      .onConflictDoNothing({
        target: [notificationsEmailMessages.eventId, notificationsEmailMessages.template],
      })
      .returning({ id: notificationsEmailMessages.id });

    if (!inserted) {
      return null;
    }

    this.refundPayloadByEmailId.set(inserted.id, {
      bookingId,
      amountMinor: BigInt(amountMinorRaw),
      currency: currencyRaw.trim() as CurrencyCode,
    });
    this.jobQueueService?.triggerNotificationSenderAsync();
    return inserted.id;
  }

  /**
   * Drains due `queued` / `failed` emails using `FOR UPDATE SKIP LOCKED` + lease timestamps,
   * never holding PostgreSQL connections across SMTP calls.
   */
  async processDueEmails(): Promise<EmailDeliverySummary> {
    let processedCount = 0;
    let sentCount = 0;
    let failedCount = 0;
    let deadCount = 0;

    for (let i = 0; i < EMAIL_BATCH_LIMIT; i++) {
      const claimed = await this.claimNextDueEmail();
      if (!claimed) {
        break;
      }

      processedCount += 1;
      try {
        const sendResult = await this.dispatchClaimedEmail(claimed);
        await this.markEmailSent(claimed.id, claimed.version, sendResult.messageId);
        sentCount += 1;
        this.logger.log(
          JSON.stringify({
            level: 'info',
            event: 'notification_email_sent',
            emailMessageId: claimed.id,
            eventId: claimed.eventId,
            template: claimed.template,
            locale: claimed.locale,
            recipientHash: claimed.recipientHash,
            providerMessageId: sendResult.messageId,
          }),
        );
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeError = redactEmailAddresses(rawMsg);
        const movedToDead = await this.markEmailFailure(claimed.id, claimed.version, safeError);
        if (movedToDead) {
          deadCount += 1;
          this.logger.error(
            JSON.stringify({
              level: 'error',
              event: 'notification_email_dead',
              emailMessageId: claimed.id,
              eventId: claimed.eventId,
              template: claimed.template,
              locale: claimed.locale,
              recipientHash: claimed.recipientHash,
              attempts: claimed.attempts + 1,
              error: safeError,
            }),
          );
        } else {
          failedCount += 1;
          this.logger.warn(
            JSON.stringify({
              level: 'warn',
              event: 'notification_email_retry_scheduled',
              emailMessageId: claimed.id,
              eventId: claimed.eventId,
              template: claimed.template,
              locale: claimed.locale,
              recipientHash: claimed.recipientHash,
              attempts: claimed.attempts + 1,
              error: safeError,
            }),
          );
        }
      }
    }

    return { processedCount, sentCount, failedCount, deadCount };
  }

  private async claimNextDueEmail(): Promise<ClaimedEmailMessage | null> {
    return this.db.transaction(async (tx) => {
      const [due] = await tx
        .select()
        .from(notificationsEmailMessages)
        .where(
          and(
            inArray(notificationsEmailMessages.status, ['queued', 'failed']),
            lte(notificationsEmailMessages.nextAttemptAt, sql`now()`),
          ),
        )
        .orderBy(
          asc(notificationsEmailMessages.nextAttemptAt),
          asc(notificationsEmailMessages.createdAt),
        )
        .limit(1)
        .for('update', { skipLocked: true });

      if (!due) {
        return null;
      }

      const [leased] = await tx
        .update(notificationsEmailMessages)
        .set({
          nextAttemptAt: sql`now() + (${CLAIM_LEASE_SECONDS} * interval '1 second')`,
          version: due.version + 1,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(notificationsEmailMessages.id, due.id),
            eq(notificationsEmailMessages.version, due.version),
          ),
        )
        .returning();

      if (!leased) {
        return null;
      }

      const eventRes = await tx.execute<{ payload: unknown; aggregate_id: string }>(
        sql`SELECT payload, aggregate_id FROM platform.outbox_events WHERE id = ${leased.eventId}::uuid LIMIT 1`,
      );
      const outboxRow = eventRes.rows[0];
      const payload =
        outboxRow && typeof outboxRow.payload === 'object' && outboxRow.payload !== null
          ? (outboxRow.payload as Record<string, unknown>)
          : {};
      const bookingId =
        typeof payload['bookingId'] === 'string'
          ? payload['bookingId']
          : (outboxRow?.aggregate_id ?? null);

      return {
        id: leased.id,
        eventId: leased.eventId,
        template: leased.template as EmailTemplate,
        bookingId,
        recipientHash: leased.recipientHash,
        locale: leased.locale,
        attempts: leased.attempts,
        version: leased.version,
      };
    });
  }

  private async dispatchClaimedEmail(claimed: ClaimedEmailMessage): Promise<{ messageId: string }> {
    const cachedRefund = this.refundPayloadByEmailId.get(claimed.id);
    const resolvedBookingId =
      cachedRefund?.bookingId ?? this.bookingIdByEmailId.get(claimed.id) ?? claimed.bookingId;

    if (!resolvedBookingId) {
      throw new Error(`Missing bookingId for email message ${claimed.id}`);
    }

    const ctx = await this.bookingService.getNotificationBookingById(resolvedBookingId);
    if (!ctx) {
      throw new Error(`Booking ${resolvedBookingId} not found for email message ${claimed.id}`);
    }

    const product = await this.catalogService.getProductSummaryForNotification(
      ctx.booking.productId,
      claimed.locale,
    );

    let rendered: { subject: string; text: string; html: string };
    switch (claimed.template) {
      case 'booking_held':
        rendered = this.renderer.renderBookingHeld(ctx, product);
        break;
      case 'booking_confirmed':
        rendered = this.renderer.renderBookingConfirmed(ctx, product);
        break;
      case 'booking_expired':
        rendered = this.renderer.renderBookingExpired(ctx, product);
        break;
      case 'booking_cancelled':
        rendered = this.renderer.renderBookingCancelled(ctx, product);
        break;
      case 'refund_succeeded': {
        const refundAmountMinor =
          cachedRefund?.amountMinor ??
          (ctx.booking.refund ? BigInt(ctx.booking.refund.amountMinor) : 0n);
        const currency = cachedRefund?.currency ?? (ctx.booking.currency.trim() as CurrencyCode);
        rendered = this.renderer.renderRefundSucceeded(ctx, product, refundAmountMinor, currency);
        break;
      }
    }

    const sendRes = await this.transport.send({
      to: ctx.booking.contactEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: {
        'X-Outbox-Event-Id': claimed.eventId,
        'X-Notification-Template': claimed.template,
      },
    });

    this.bookingIdByEmailId.delete(claimed.id);
    this.refundPayloadByEmailId.delete(claimed.id);
    return sendRes;
  }

  private async markEmailSent(
    id: string,
    expectedVersion: number,
    messageId: string,
  ): Promise<void> {
    await this.db
      .update(notificationsEmailMessages)
      .set({
        status: 'sent',
        providerMessageId: messageId,
        sentAt: sql`now()`,
        lastError: null,
        version: expectedVersion + 1,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(notificationsEmailMessages.id, id),
          eq(notificationsEmailMessages.version, expectedVersion),
        ),
      );
  }

  private async markEmailFailure(
    id: string,
    expectedVersion: number,
    safeError: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(notificationsEmailMessages)
        .where(
          and(
            eq(notificationsEmailMessages.id, id),
            eq(notificationsEmailMessages.version, expectedVersion),
          ),
        )
        .for('update');

      if (!current) {
        return false;
      }

      const nextAttempts = current.attempts + 1;
      const isDead = nextAttempts >= MAX_EMAIL_ATTEMPTS;
      const backoffMs = isDead
        ? 0
        : calculateExponentialBackoffMs(nextAttempts, EMAIL_BASE_BACKOFF_MS);

      await tx
        .update(notificationsEmailMessages)
        .set({
          status: isDead ? 'dead' : 'failed',
          attempts: nextAttempts,
          lastError: safeError,
          nextAttemptAt: isDead
            ? current.nextAttemptAt
            : sql`now() + (${backoffMs} * interval '1 millisecond')`,
          version: current.version + 1,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(notificationsEmailMessages.id, current.id),
            eq(notificationsEmailMessages.version, current.version),
          ),
        );

      return isDead;
    });
  }
}
