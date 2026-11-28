import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  and,
  createDbClient,
  type DatabaseClient,
  inArray,
  isNotNull,
  isNull,
  or,
  outboxEvents,
  sql,
} from '@internationalota/db';
import { type AppEnv, resolveAppEnv } from '@internationalota/shared';
import { BOOKING_OUTBOX_EVENTS_WITHOUT_CONSUMERS } from '../modules/booking/index.js';
import { OPS_OUTBOX_EVENTS_WITHOUT_CONSUMERS } from '../modules/ops/index.js';
import { PAYMENTS_OUTBOX_EVENTS_WITHOUT_CONSUMERS } from '../modules/payments/index.js';

export class StagingOutboxCleanupProductionForbiddenError extends Error {
  constructor() {
    super('Refusing to run staging:outbox-cleanup in APP_ENV=production.');
    this.name = 'StagingOutboxCleanupProductionForbiddenError';
  }
}

export interface StagingOutboxCleanupOptions {
  readonly appEnv?: AppEnv;
  readonly includeLegacyUnhandled?: boolean;
}

export interface StagingOutboxCleanupResult {
  readonly appEnv: AppEnv;
  readonly declaredUpdated: number;
  readonly legacyUnhandledUpdated: number;
  readonly totalUpdated: number;
}

export function getDeclaredNoConsumerOutboxTypes(): readonly string[] {
  return Array.from(
    new Set([
      ...BOOKING_OUTBOX_EVENTS_WITHOUT_CONSUMERS,
      ...PAYMENTS_OUTBOX_EVENTS_WITHOUT_CONSUMERS,
      ...OPS_OUTBOX_EVENTS_WITHOUT_CONSUMERS,
    ]),
  );
}

/**
 * Marks historical staging dead-lettered / high-retry outbox rows of declared
 * no-consumer event types as processed with `outcome = 'no_consumer'` so daily
 * reconciliation stays noise-free while leaving genuine failure rows untouched.
 */
export async function cleanupDeadLetteredNoConsumerOutbox(
  db: DatabaseClient,
  options: StagingOutboxCleanupOptions = {},
): Promise<StagingOutboxCleanupResult> {
  const appEnv = options.appEnv ?? resolveAppEnv();
  if (appEnv === 'production') {
    throw new StagingOutboxCleanupProductionForbiddenError();
  }

  const declaredTypes = getDeclaredNoConsumerOutboxTypes();
  const stuckOrDeadCondition = or(
    isNotNull(outboxEvents.deadLetteredAt),
    isNull(outboxEvents.publishedAt),
  );

  return db.transaction(async (tx) => {
    const declaredRows =
      declaredTypes.length > 0
        ? await tx
            .update(outboxEvents)
            .set({
              publishedAt: sql`COALESCE(${outboxEvents.publishedAt}, now())`,
              outcome: 'no_consumer',
              deadLetteredAt: null,
              lastError: null,
            })
            .where(and(inArray(outboxEvents.eventType, [...declaredTypes]), stuckOrDeadCondition))
            .returning({ id: outboxEvents.id })
        : [];

    let legacyRows: { id: string }[] = [];
    if (options.includeLegacyUnhandled) {
      legacyRows = await tx
        .update(outboxEvents)
        .set({
          publishedAt: sql`COALESCE(${outboxEvents.publishedAt}, now())`,
          outcome: 'no_consumer',
          deadLetteredAt: null,
          lastError: null,
        })
        .where(
          and(
            isNotNull(outboxEvents.deadLetteredAt),
            sql`${outboxEvents.lastError} LIKE 'No handler registered for outbox event type %'`,
          ),
        )
        .returning({ id: outboxEvents.id });
    }

    return {
      appEnv,
      declaredUpdated: declaredRows.length,
      legacyUnhandledUpdated: legacyRows.length,
      totalUpdated: declaredRows.length + legacyRows.length,
    };
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const includeLegacyUnhandled = process.argv.includes('--include-legacy-unhandled');

  const client = createDbClient({ connectionString: databaseUrl });
  try {
    const result = await cleanupDeadLetteredNoConsumerOutbox(client.db, {
      includeLegacyUnhandled,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    await client.pool.end();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
