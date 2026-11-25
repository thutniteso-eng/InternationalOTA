import type { IncomingHttpHeaders } from 'node:http';
import {
  and,
  asc,
  type DatabaseClient,
  eq,
  inboxMessages,
  isNull,
  lte,
  sql,
} from '@internationalota/db';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  calculateExponentialBackoffMs,
  type InboxMessageHandler,
  type InboxRelayOptions,
  type WebhookVerifier,
} from './messaging.types.js';
import { TestHmacWebhookVerifier } from './test-webhook.verifier.js';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_BACKOFF_MS = 1000;

/**
 * Webhook inbox service: verifies incoming provider webhooks on raw bytes,
 * deduplicates via `PRIMARY KEY (provider, provider_event_id)`, and processes
 * them asynchronously with the same SKIP LOCKED / retry / dead-letter rules
 * as the transactional outbox.
 *
 * Raw payloads are stored as received and NEVER logged at INFO (may contain PII).
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);
  private readonly verifiers = new Map<string, WebhookVerifier>();
  private readonly handlers = new Map<string, InboxMessageHandler>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private shuttingDown = false;

  constructor(@Inject(DRIZZLE_DB) private readonly db: DatabaseClient) {
    this.registerVerifier(new TestHmacWebhookVerifier());
  }

  registerVerifier(verifier: WebhookVerifier): void {
    this.verifiers.set(verifier.provider, verifier);
  }

  registerHandler(provider: string, handler: InboxMessageHandler): void {
    this.handlers.set(provider, handler);
  }

  clearHandlers(): void {
    this.handlers.clear();
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  resetShutdownForTest(): void {
    this.shuttingDown = false;
  }

  async waitForInFlight(): Promise<void> {
    if (this.inFlight.size === 0) {
      return;
    }
    await Promise.allSettled(Array.from(this.inFlight));
  }

  async receiveWebhook(
    provider: string,
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): Promise<{ accepted: true; duplicate: boolean; eventId: string }> {
    const verifier = this.verifiers.get(provider);
    if (!verifier) {
      throw new NotFoundException(`Unknown webhook provider: ${provider}`);
    }

    let verified: { eventId: string; payload: Record<string, unknown> };
    try {
      verified = verifier.verify(rawBody, headers);
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const inserted = await this.db
      .insert(inboxMessages)
      .values({
        provider,
        providerEventId: verified.eventId,
        payload: verified.payload,
      })
      .onConflictDoNothing()
      .returning({ providerEventId: inboxMessages.providerEventId });

    const duplicate = inserted.length === 0;

    // Log metadata only — NEVER log raw payload (may contain PII)
    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'webhook_received',
        provider,
        providerEventId: verified.eventId,
        duplicate,
      }),
    );

    return { accepted: true, duplicate, eventId: verified.eventId };
  }

  async relayBatch(options: InboxRelayOptions = {}): Promise<number> {
    if (this.shuttingDown) {
      return 0;
    }

    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

    const runPromise = this.db.transaction(async (tx) => {
      const claimed = await tx
        .select()
        .from(inboxMessages)
        .where(
          and(
            isNull(inboxMessages.processedAt),
            isNull(inboxMessages.deadLetteredAt),
            lte(inboxMessages.nextAttemptAt, sql`now()`),
          ),
        )
        .orderBy(asc(inboxMessages.receivedAt))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      for (const message of claimed) {
        const handler = this.handlers.get(message.provider);
        try {
          if (!handler) {
            throw new Error(`No handler registered for webhook provider "${message.provider}"`);
          }
          await handler(message);

          await tx
            .update(inboxMessages)
            .set({
              processedAt: sql`now()`,
              lastError: null,
            })
            .where(
              and(
                eq(inboxMessages.provider, message.provider),
                eq(inboxMessages.providerEventId, message.providerEventId),
              ),
            );
        } catch (err: unknown) {
          const nextAttempts = message.attempts + 1;
          const errorMessage = err instanceof Error ? err.message : String(err);

          if (nextAttempts >= maxAttempts) {
            await tx
              .update(inboxMessages)
              .set({
                attempts: nextAttempts,
                lastError: errorMessage,
                deadLetteredAt: sql`now()`,
              })
              .where(
                and(
                  eq(inboxMessages.provider, message.provider),
                  eq(inboxMessages.providerEventId, message.providerEventId),
                ),
              );

            this.logger.error(
              JSON.stringify({
                level: 'error',
                event: 'inbox_message_dead_lettered',
                provider: message.provider,
                providerEventId: message.providerEventId,
                attempts: nextAttempts,
                lastError: errorMessage,
              }),
            );
          } else {
            const backoffMs = calculateExponentialBackoffMs(nextAttempts, baseBackoffMs);
            await tx
              .update(inboxMessages)
              .set({
                attempts: nextAttempts,
                lastError: errorMessage,
                nextAttemptAt: sql`now() + (${backoffMs} * interval '1 millisecond')`,
              })
              .where(
                and(
                  eq(inboxMessages.provider, message.provider),
                  eq(inboxMessages.providerEventId, message.providerEventId),
                ),
              );
          }
        }
      }

      return claimed.length;
    });

    this.inFlight.add(runPromise);
    try {
      return await runPromise;
    } finally {
      this.inFlight.delete(runPromise);
    }
  }
}
