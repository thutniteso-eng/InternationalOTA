import {
  and,
  asc,
  type DatabaseClient,
  type DatabaseTransaction,
  eq,
  isNull,
  lte,
  type OutboxEvent,
  outboxEvents,
  sql,
} from '@internationalota/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { getRequestId, runWithRequestContext } from '../../common/observability/request-context.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  calculateExponentialBackoffMs,
  type EnqueueOutboxEventInput,
  type OutboxEventHandler,
  type OutboxRelayOptions,
} from './messaging.types.js';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_BACKOFF_MS = 1000;

/**
 * Transactional outbox service.
 *
 * Guarantees at-least-once delivery of domain events written in the same
 * PostgreSQL transaction as the business state change.
 *
 * Because delivery is at-least-once (a process crash between running a handler
 * and committing `published_at` will trigger redelivery), all registered
 * `OutboxEventHandler` implementations MUST be idempotent.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly handlers = new Map<string, OutboxEventHandler>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private shuttingDown = false;

  constructor(@Inject(DRIZZLE_DB) private readonly db: DatabaseClient) {}

  /**
   * Enqueues an outbox event inside the caller's Drizzle transaction.
   * There is intentionally no overload without a transaction handle.
   */
  async enqueue(tx: DatabaseTransaction, event: EnqueueOutboxEventInput): Promise<OutboxEvent> {
    const requestId = getRequestId();
    const existingMeta =
      typeof event.payload['_meta'] === 'object' && event.payload['_meta'] !== null
        ? (event.payload['_meta'] as Record<string, unknown>)
        : {};
    const payload = requestId
      ? {
          ...event.payload,
          _meta: {
            ...existingMeta,
            requestId,
          },
        }
      : event.payload;

    const [inserted] = await tx
      .insert(outboxEvents)
      .values({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload,
      })
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert outbox event');
    }

    return inserted;
  }

  registerHandler(eventType: string, handler: OutboxEventHandler): void {
    this.handlers.set(eventType, handler);
  }

  clearHandlers(): void {
    this.handlers.clear();
  }

  getMaxAttempts(): number {
    const raw = process.env['OUTBOX_MAX_ATTEMPTS'];
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ATTEMPTS;
  }

  getBaseBackoffMs(): number {
    const raw = process.env['OUTBOX_BASE_BACKOFF_MS'];
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BASE_BACKOFF_MS;
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

  /**
   * Claims a batch of due unpublished outbox events using
   * `SELECT ... FOR UPDATE SKIP LOCKED`, dispatches each to its registered
   * handler, and marks either `published_at`, retry backoff, or `dead_lettered_at`.
   */
  async relayBatch(options: OutboxRelayOptions = {}): Promise<number> {
    if (this.shuttingDown) {
      return 0;
    }

    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxAttempts = options.maxAttempts ?? this.getMaxAttempts();
    const baseBackoffMs = options.baseBackoffMs ?? this.getBaseBackoffMs();

    const runPromise = this.db.transaction(async (tx) => {
      const claimed = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            isNull(outboxEvents.publishedAt),
            isNull(outboxEvents.deadLetteredAt),
            lte(outboxEvents.nextAttemptAt, sql`now()`),
          ),
        )
        .orderBy(asc(outboxEvents.occurredAt))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      for (const event of claimed) {
        const handler = this.handlers.get(event.eventType);
        const attempt = event.attempts + 1;
        const payloadObj =
          typeof event.payload === 'object' && event.payload !== null
            ? (event.payload as Record<string, unknown>)
            : null;
        const metaObj =
          payloadObj && typeof payloadObj['_meta'] === 'object' && payloadObj['_meta'] !== null
            ? (payloadObj['_meta'] as Record<string, unknown>)
            : null;
        const eventRequestId =
          typeof metaObj?.['requestId'] === 'string' ? metaObj['requestId'] : undefined;

        let handlerError: unknown = null;
        let handlerSucceeded = false;

        const executeHandler = async (): Promise<void> => {
          if (!handler) {
            throw new Error(`No handler registered for outbox event type "${event.eventType}"`);
          }
          await handler(event);
        };

        try {
          if (eventRequestId) {
            await runWithRequestContext(eventRequestId, executeHandler);
          } else {
            await executeHandler();
          }
          handlerSucceeded = true;
        } catch (err: unknown) {
          handlerError = err;
        }

        if (handlerSucceeded) {
          // Optional hook for simulating a crash between handler execution and marking published_at
          if (options.afterHandleHook) {
            await options.afterHandleHook(event);
          }

          await tx
            .update(outboxEvents)
            .set({
              publishedAt: sql`now()`,
              lastError: null,
            })
            .where(eq(outboxEvents.id, event.id));

          this.logger.log(
            JSON.stringify({
              event: 'outbox_event_published',
              eventId: event.id,
              eventType: event.eventType,
              attempt,
              ...(eventRequestId ? { requestId: eventRequestId } : {}),
            }),
          );
        } else {
          const nextAttempts = attempt;
          const errorMessage =
            handlerError instanceof Error ? handlerError.message : String(handlerError);

          if (nextAttempts >= maxAttempts) {
            await tx
              .update(outboxEvents)
              .set({
                attempts: nextAttempts,
                lastError: errorMessage,
                deadLetteredAt: sql`now()`,
              })
              .where(eq(outboxEvents.id, event.id));

            this.logger.error(
              JSON.stringify({
                level: 'error',
                event: 'outbox_event_dead_lettered',
                eventId: event.id,
                outboxEventId: event.id,
                aggregateType: event.aggregateType,
                aggregateId: event.aggregateId,
                eventType: event.eventType,
                attempt: nextAttempts,
                attempts: nextAttempts,
                lastError: errorMessage,
                ...(eventRequestId ? { requestId: eventRequestId } : {}),
              }),
            );
          } else {
            const backoffMs = calculateExponentialBackoffMs(nextAttempts, baseBackoffMs);
            await tx
              .update(outboxEvents)
              .set({
                attempts: nextAttempts,
                lastError: errorMessage,
                nextAttemptAt: sql`now() + (${backoffMs} * interval '1 millisecond')`,
              })
              .where(eq(outboxEvents.id, event.id));

            this.logger.warn(
              JSON.stringify({
                event: 'outbox_event_retry_scheduled',
                eventId: event.id,
                eventType: event.eventType,
                attempt: nextAttempts,
                lastError: errorMessage,
                ...(eventRequestId ? { requestId: eventRequestId } : {}),
              }),
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
