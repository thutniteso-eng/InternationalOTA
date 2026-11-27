import { type DatabaseClient, idempotencyKeys, lt, sql } from '@internationalota/db';
import { resolveAppEnv } from '@internationalota/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PgBoss } from 'pg-boss';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { InboxService } from './inbox.service.js';
import { BOOKING_EXPIRY_WORKER_PORT, type BookingExpiryWorkerPort } from './messaging.types.js';
import { OutboxService } from './outbox.service.js';

export const QUEUE_OUTBOX_RELAY = 'outbox-relay';
export const QUEUE_INBOX_RELAY = 'inbox-relay';
export const QUEUE_IDEMPOTENCY_CLEANUP = 'idempotency-keys-cleanup';
export const QUEUE_BOOKING_EXPIRY = 'booking-hold-expiry';

const EXPIRY_WORKER_BATCH_LIMIT = 50;

/**
 * Manages the pg-boss PostgreSQL job queue, relay loops, scheduled jobs
 * (`idempotency-keys-cleanup`), and graceful shutdown lifecycle.
 */
@Injectable()
export class JobQueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobQueueService.name);
  private boss: PgBoss | null = null;
  private started = false;
  private bookingExpiryWorker: BookingExpiryWorkerPort | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly outboxService: OutboxService,
    private readonly inboxService: InboxService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.bookingExpiryWorker = this.moduleRef.get<BookingExpiryWorkerPort>(
        BOOKING_EXPIRY_WORKER_PORT,
        { strict: false },
      );
    } catch {
      this.bookingExpiryWorker = null;
      this.logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'booking_expiry_worker_unbound',
          message: 'BOOKING_EXPIRY_WORKER_PORT is not registered in this application context.',
        }),
      );
    }

    if (process.env['PG_BOSS_DISABLED'] === 'true') {
      return;
    }

    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error('DATABASE_URL is required to start pg-boss JobQueueService.');
    }

    const appEnv = resolveAppEnv();
    const shouldMigrateSchema =
      process.env['PG_BOSS_MIGRATE'] !== 'false' && (appEnv === 'local' || appEnv === 'test');

    const boss = new PgBoss({
      connectionString,
      migrate: shouldMigrateSchema,
      createSchema: shouldMigrateSchema,
      supervise: process.env['NODE_ENV'] !== 'test' && shouldMigrateSchema,
      schedule: true,
    });

    boss.on('error', (err) => {
      this.logger.error(
        JSON.stringify({
          level: 'error',
          event: 'pg_boss_error',
          message: err.message,
        }),
      );
    });

    await boss.start();
    this.boss = boss;
    this.started = true;

    await boss.createQueue(QUEUE_OUTBOX_RELAY);
    await boss.createQueue(QUEUE_INBOX_RELAY);
    await boss.createQueue(QUEUE_IDEMPOTENCY_CLEANUP);
    await boss.createQueue(QUEUE_BOOKING_EXPIRY);

    await boss.work(QUEUE_OUTBOX_RELAY, async () => {
      let processed = 0;
      do {
        processed = await this.outboxService.relayBatch();
      } while (processed > 0 && !this.outboxService.isShuttingDown());
    });

    await boss.work(QUEUE_INBOX_RELAY, async () => {
      let processed = 0;
      do {
        processed = await this.inboxService.relayBatch();
      } while (processed > 0 && !this.inboxService.isShuttingDown());
    });

    await boss.work(QUEUE_IDEMPOTENCY_CLEANUP, async () => {
      await this.cleanupExpiredIdempotencyKeys();
    });

    await boss.work(QUEUE_BOOKING_EXPIRY, async () => {
      await this.runBookingExpiryBatch();
    });

    // Daily cleanup of expired platform.idempotency_keys rows
    await boss.schedule(QUEUE_IDEMPOTENCY_CLEANUP, '0 3 * * *');
    await boss.schedule(QUEUE_OUTBOX_RELAY, '* * * * *');
    await boss.schedule(QUEUE_INBOX_RELAY, '* * * * *');
    await boss.schedule(QUEUE_BOOKING_EXPIRY, '* * * * *');

    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'booking_expiry_job_scheduled',
        queue: QUEUE_BOOKING_EXPIRY,
        cron: '* * * * *',
      }),
    );
  }

  /**
   * Drains due booking holds via the registered BookingExpiryWorkerPort (idempotent under SKIP LOCKED).
   */
  async runBookingExpiryBatch(): Promise<{ expiredCount: number; skippedCount: number }> {
    if (!this.bookingExpiryWorker) {
      return { expiredCount: 0, skippedCount: 0 };
    }
    let totalExpired = 0;
    let totalSkipped = 0;
    let lastExpired = 0;
    do {
      const res = await this.bookingExpiryWorker.expireDue({ limit: EXPIRY_WORKER_BATCH_LIMIT });
      totalExpired += res.expiredCount;
      totalSkipped += res.skippedCount;
      lastExpired = res.expiredCount;
    } while (lastExpired === EXPIRY_WORKER_BATCH_LIMIT && !this.outboxService.isShuttingDown());

    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'booking_expiry_job_completed',
        expiredCount: totalExpired,
        skippedCount: totalSkipped,
      }),
    );

    return { expiredCount: totalExpired, skippedCount: totalSkipped };
  }

  /**
   * Deletes expired rows (`expires_at < now()`) from `platform.idempotency_keys`.
   * Returns the number of deleted rows.
   */
  async cleanupExpiredIdempotencyKeys(): Promise<number> {
    const deleted = await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, sql`now()`))
      .returning({ key: idempotencyKeys.key });

    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'idempotency_keys_cleanup_completed',
        deletedCount: deleted.length,
      }),
    );

    return deleted.length;
  }

  /**
   * Triggers an immediate pg-boss job on the given queue (e.g. for tests or manual dispatch).
   */
  async sendJob(queueName: string, data: Record<string, unknown> = {}): Promise<string | null> {
    if (!this.boss || !this.started) {
      throw new Error('JobQueueService is not started');
    }
    return this.boss.send(queueName, data);
  }

  /**
   * Graceful shutdown: stop claiming new work, wait for in-flight handlers, then close pg-boss.
   */
  async onApplicationShutdown(): Promise<void> {
    this.outboxService.beginShutdown();
    this.inboxService.beginShutdown();

    if (this.boss && this.started) {
      this.started = false;
      try {
        await this.boss.stop({ graceful: true, timeout: 10_000 });
      } catch (err: unknown) {
        this.logger.warn(
          JSON.stringify({
            level: 'warn',
            event: 'pg_boss_stop_warning',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      this.boss = null;
    }

    await Promise.all([this.outboxService.waitForInFlight(), this.inboxService.waitForInFlight()]);
  }
}
