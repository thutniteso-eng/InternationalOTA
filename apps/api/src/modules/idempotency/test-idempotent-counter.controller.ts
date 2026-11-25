import { appMeta, type DatabaseClient, eq, sql } from '@internationalota/db';
import { Body, Controller, Get, Inject, InternalServerErrorException, Post } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { Idempotent } from './idempotent.decorator.js';

const COUNTER_KEY = 'test_idempotent_counter';

export interface TestGateEntry {
  open: Promise<void>;
  release: () => void;
}

/**
 * Test-only gate controlled by integration tests to deterministically hold
 * in-flight requests inside the handler while concurrent or takeover requests arrive.
 */
export const testGate = {
  holdFirst: false,
  open: Promise.resolve(),
  release: (): void => {},
  queue: [] as TestGateEntry[],
};

export interface IncrementCounterBody {
  shouldFail?: boolean;
  throwSecretError?: boolean;
  useGate?: boolean;
  value?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Test-only controller registered when NODE_ENV === 'test'.
 * Provides an idempotent counter endpoint to verify concurrency, replay, and error semantics.
 */
@Controller('__test/idempotent-counter')
export class TestIdempotentCounterController {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DatabaseClient) {}

  @Post()
  @Idempotent()
  async incrementCounter(@Body() body?: IncrementCounterBody) {
    if (body?.useGate !== false) {
      if (testGate.queue.length > 0) {
        const nextGate = testGate.queue.shift();
        if (nextGate) {
          await nextGate.open;
        }
      } else if (testGate.holdFirst) {
        testGate.holdFirst = false;
        await testGate.open;
      }
    }

    if (body?.throwSecretError) {
      throw new Error('secret SQL detail: SELECT * FROM internal_secrets');
    }

    if (body?.shouldFail) {
      throw new InternalServerErrorException('Simulated test failure inside idempotent handler');
    }

    const [row] = await this.db
      .insert(appMeta)
      .values({
        key: COUNTER_KEY,
        value: { count: 1 },
      })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: {
          value: sql`jsonb_build_object('count', COALESCE((${appMeta.value}->>'count')::int, 0) + 1)`,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    const count = ((row?.value as Record<string, unknown>)?.count as number) ?? 1;
    return { count };
  }

  @Get()
  async getCounter() {
    const [row] = await this.db.select().from(appMeta).where(eq(appMeta.key, COUNTER_KEY));

    const count = ((row?.value as Record<string, unknown>)?.count as number) ?? 0;
    return { count };
  }

  @Post('reset')
  async resetCounter() {
    await this.db
      .insert(appMeta)
      .values({
        key: COUNTER_KEY,
        value: { count: 0 },
      })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: {
          value: { count: 0 },
          updatedAt: sql`now()`,
        },
      });

    return { count: 0 };
  }
}
