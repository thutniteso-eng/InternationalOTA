import { appMeta, type DatabaseClient, idempotencyKeys } from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { computeRequestHash } from './hash.js';
import { testGate } from './test-idempotent-counter.controller.js';

const TEST_AUTH_SECRET = 'test-better-auth-secret-key-at-least-32-chars';

function closeTestGate(): () => void {
  let release!: () => void;
  testGate.holdFirst = true;
  testGate.open = new Promise<void>((resolve) => {
    release = resolve;
  });
  testGate.release = release;
  return release;
}

function enqueueTestGate(): () => void {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  testGate.queue.push({ open, release });
  return release;
}

function resetTestGate(): void {
  testGate.holdFirst = false;
  testGate.release();
  testGate.open = Promise.resolve();
  testGate.release = (): void => {};
  while (testGate.queue.length > 0) {
    const entry = testGate.queue.shift();
    entry?.release();
  }
}

async function waitForInProgressRow(
  db: DatabaseClient,
  key: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    if (row && row.state === 'in_progress') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for idempotency row "${key}" to reach state='in_progress'`);
}

describe('Idempotency module integration tests', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousAuthSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = TEST_AUTH_SECRET;
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.testUrl;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
  });

  afterAll(async () => {
    resetTestGate();
    if (app) {
      await app.close();
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousAuthSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = previousAuthSecret;
    }
    if (testDb) {
      await testDb.teardown();
    }
  });

  beforeEach(async () => {
    resetTestGate();
    // Clean up test rows in the isolated temporary test database before each test
    await db.delete(idempotencyKeys);
    await db.delete(appMeta).where(eq(appMeta.key, 'test_idempotent_counter'));
  });

  afterEach(() => {
    resetTestGate();
  });

  it('Criterion 1: Concurrency - 1 in-flight request holds gate while 19 parallel requests receive 409, then counter is 1 and retry replays', async () => {
    const key = 'test-concurrent-key-001';
    const payload = { action: 'increment', step: 1 };

    // 1. Create a closed gate so request #1 pauses inside the handler
    const releaseGate = closeTestGate();

    // 2. Fire request #1 (do not await yet)
    const firstRequestPromise = fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    });

    // 3. Poll the DB until request #1's row is persisted with state='in_progress'
    await waitForInProgressRow(db, key);

    // 4. Fire the other 19 requests in parallel and await all of them
    const concurrentRequests = Array.from({ length: 19 }, () =>
      fetch(`${baseUrl}/__test/idempotent-counter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      }),
    );

    const concurrentResponses = await Promise.all(concurrentRequests);

    // 5. Assert ALL 19 received 409 Conflict with Retry-After: 1 and problem+json
    for (const res of concurrentResponses) {
      expect(res.status).toBe(409);
      expect(res.headers.get('Retry-After')).toBe('1');
      expect(res.headers.get('Content-Type')).toContain('application/problem+json');
      const problem = (await res.json()) as {
        type: string;
        title: string;
        status: number;
        detail: string;
      };
      expect(problem.status).toBe(409);
      expect(problem.title).toBe('Conflict');
    }

    // 6. Release the gate and await request #1
    releaseGate();
    const firstRes = await firstRequestPromise;
    expect(firstRes.status).toBe(201);
    expect(firstRes.headers.get('Idempotent-Replayed')).toBeNull();
    const firstBody = (await firstRes.json()) as { count: number };
    expect(firstBody.count).toBe(1);

    // Verify database counter row was incremented exactly once
    const [counterRow] = await db
      .select()
      .from(appMeta)
      .where(eq(appMeta.key, 'test_idempotent_counter'));
    const finalCount = ((counterRow?.value as Record<string, unknown>)?.count as number) ?? 0;
    expect(finalCount).toBe(1);

    // Verify idempotency record is completed in database
    const [idempRow] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key)));
    expect(idempRow?.state).toBe('completed');
    expect(idempRow?.responseStatus).toBe(201);

    // 7. Send one more request with the same key -> must replay and keep counter at 1
    const replayRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    });
    expect(replayRes.status).toBe(201);
    expect(replayRes.headers.get('Idempotent-Replayed')).toBe('true');
    const replayBody = (await replayRes.json()) as { count: number };
    expect(replayBody).toEqual({ count: 1 });

    const [counterAfterReplay] = await db
      .select()
      .from(appMeta)
      .where(eq(appMeta.key, 'test_idempotent_counter'));
    expect(((counterAfterReplay?.value as Record<string, unknown>)?.count as number) ?? 0).toBe(1);
  });

  it('Criterion 2: Sequential retry after completion returns replay header and leaves counter unchanged', async () => {
    const key = 'test-sequential-key-002';
    const payload = { action: 'increment' };

    // Initial request
    const firstRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    });
    expect(firstRes.status).toBe(201);
    expect(firstRes.headers.get('Idempotent-Replayed')).toBeNull();
    const firstBody = (await firstRes.json()) as { count: number };
    expect(firstBody.count).toBe(1);

    // Immediate sequential retry with identical key & body
    const retryRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    });
    expect(retryRes.status).toBe(201);
    expect(retryRes.headers.get('Idempotent-Replayed')).toBe('true');
    const retryBody = (await retryRes.json()) as { count: number };
    expect(retryBody).toEqual(firstBody);

    // Database counter remains 1
    const [counterRow] = await db
      .select()
      .from(appMeta)
      .where(eq(appMeta.key, 'test_idempotent_counter'));
    const finalCount = ((counterRow?.value as Record<string, unknown>)?.count as number) ?? 0;
    expect(finalCount).toBe(1);
  });

  it('Criterion 3: Same key with different payload returns 422 problem+json', async () => {
    const key = 'test-mismatch-key-003';

    // 1. Initial request with payload A
    const firstRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(firstRes.status).toBe(201);

    // 2. Second request with same key but payload B
    const mismatchRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ amount: 200 }),
    });

    expect(mismatchRes.status).toBe(422);
    expect(mismatchRes.headers.get('Content-Type')).toContain('application/problem+json');
    const problem = (await mismatchRes.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
    };
    expect(problem.status).toBe(422);
    expect(problem.title).toBe('Unprocessable Entity');
    expect(problem.type).toBe('https://httpstatuses.com/422');
    expect(problem.detail).toContain('different request payload');
  });

  it('Criterion 4: Missing or invalid key returns 400 problem+json; non-decorated routes unaffected', async () => {
    // Missing Idempotency-Key header
    const missingRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'increment' }),
    });
    expect(missingRes.status).toBe(400);
    expect(missingRes.headers.get('Content-Type')).toContain('application/problem+json');
    const missingProblem = (await missingRes.json()) as { status: number; title: string };
    expect(missingProblem.status).toBe(400);
    expect(missingProblem.title).toBe('Bad Request');

    // Invalid key with space
    const spaceRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'invalid key with space',
      },
      body: JSON.stringify({ action: 'increment' }),
    });
    expect(spaceRes.status).toBe(400);

    // Invalid empty key
    const emptyRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '',
      },
      body: JSON.stringify({ action: 'increment' }),
    });
    expect(emptyRes.status).toBe(400);

    // Non-decorated endpoint: GET /__test/idempotent-counter has no Idempotency-Key requirement
    const getRes = await fetch(`${baseUrl}/__test/idempotent-counter`);
    expect(getRes.status).toBe(200);

    // Non-decorated endpoint: GET /health unaffected
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
  });

  it('Criterion 5: Handler throws exception -> row deleted -> retry executes and succeeds', async () => {
    const key = 'test-fail-retry-key-005';

    // 1. Initial request triggers failure inside handler
    const failRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ shouldFail: true }),
    });
    expect(failRes.status).toBe(500);
    expect(failRes.headers.get('Content-Type')).toContain('application/problem+json');
    const failProblem = (await failRes.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
    };
    expect(failProblem.detail).toBe('An unexpected internal error occurred');

    // Verify row was deleted from platform.idempotency_keys
    const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    expect(rows).toHaveLength(0);

    // 2. Client retries with same key and normal payload -> succeeds
    const successRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ shouldFail: false }),
    });
    expect(successRes.status).toBe(201);
    const body = (await successRes.json()) as { count: number };
    expect(body.count).toBe(1);

    // Verify row is now completed in database
    const [completedRow] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key));
    expect(completedRow?.state).toBe('completed');
  });

  it('Criterion 6: Expired row or stale in_progress row is taken over and executed', async () => {
    const expiredKey = 'test-expired-key-006';
    const staleKey = 'test-stale-key-006';
    const scope = 'POST /__test/idempotent-counter';

    // 1. Simulate an expired row (expires_at in past)
    await db.insert(idempotencyKeys).values({
      scope,
      key: expiredKey,
      requestHash: '0000000000000000000000000000000000000000000000000000000000000000',
      state: 'completed',
      responseStatus: 200,
      responseBody: { count: 999 },
      lockedUntil: sql`now() - interval '2 hours'`,
      expiresAt: sql`now() - interval '1 hour'`,
    });

    // Send request with expired key -> must take over and increment counter
    const expiredRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': expiredKey,
      },
      body: JSON.stringify({ action: 'takeover-expired' }),
    });
    expect(expiredRes.status).toBe(201);
    expect(expiredRes.headers.get('Idempotent-Replayed')).toBeNull();
    const expiredData = (await expiredRes.json()) as { count: number };
    expect(expiredData.count).toBe(1);

    // 2. Simulate a stale in_progress row (locked_until in past)
    await db.insert(idempotencyKeys).values({
      scope,
      key: staleKey,
      requestHash: '1111111111111111111111111111111111111111111111111111111111111111',
      state: 'in_progress',
      lockedUntil: sql`now() - interval '10 seconds'`,
      expiresAt: sql`now() + interval '24 hours'`,
    });

    // Send request with stale key -> must take over and increment counter
    const staleRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': staleKey,
      },
      body: JSON.stringify({ action: 'takeover-stale' }),
    });
    expect(staleRes.status).toBe(201);
    expect(staleRes.headers.get('Idempotent-Replayed')).toBeNull();
    const staleData = (await staleRes.json()) as { count: number };
    expect(staleData.count).toBe(2);
  });

  it('G2: 5xx errors never leak internal Error messages to clients', async () => {
    const key = 'test-secret-error-key-g2';

    const res = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ throwSecretError: true }),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/problem+json');
    const rawText = await res.text();
    expect(rawText).not.toContain('secret SQL detail');
    expect(rawText).not.toContain('internal_secrets');

    const problem = JSON.parse(rawText) as {
      type: string;
      title: string;
      status: number;
      detail: string;
    };
    expect(problem).toEqual({
      type: 'https://httpstatuses.com/500',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected internal error occurred',
    });

    // Row must also be deleted so the client can retry
    const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    expect(rows).toHaveLength(0);
  });

  it('G5: Fencing on completion prevents a stale execution from overwriting a takeover execution', async () => {
    const key = 'test-fencing-key-g5';
    const scope = 'POST /__test/idempotent-counter';
    const payload1 = { value: 1, useGate: true };
    const payload2 = { value: 2, useGate: false };

    // 1. Close gate and start execution #1
    const releaseGate = closeTestGate();
    const firstPromise = fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload1),
    });

    await waitForInProgressRow(db, key);

    // 2. Simulate execution #1's 60s lock expiring while it is still running
    await db
      .update(idempotencyKeys)
      .set({ lockedUntil: sql`now() - interval '10 seconds'` })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));

    // 3. Execution #2 arrives (bypassing testGate) -> takes over and completes with count = 1
    const secondRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload2),
    });
    expect(secondRes.status).toBe(201);
    expect(secondRes.headers.get('Idempotent-Replayed')).toBeNull();
    const secondBody = (await secondRes.json()) as { count: number };
    expect(secondBody).toEqual({ count: 1 });

    // 4. Release gate so stale execution #1 finishes -> must return its own response as-is
    //    (NOT replayed) and MUST NOT overwrite execution #2's completed row in DB
    releaseGate();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(201);
    expect(firstRes.headers.get('Idempotent-Replayed')).toBeNull();
    const firstBody = (await firstRes.json()) as { count: number };
    expect(firstBody).toEqual({ count: 2 });

    // 5. Verify DB row still stores execution #2's hash and responseBody ({ count: 1 })
    const [storedRow] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    expect(storedRow?.state).toBe('completed');
    expect(storedRow?.requestHash).toBe(computeRequestHash(scope, payload2));
    expect(storedRow?.responseBody).toEqual({ count: 1 });

    // 6. A subsequent retry with payload2 replays execution #2's stored response ({ count: 1 })
    const replayRes = await fetch(`${baseUrl}/__test/idempotent-counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload2),
    });
    expect(replayRes.status).toBe(201);
    expect(replayRes.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await replayRes.json()).toEqual({ count: 1 });
  });

  it('H1: Same-payload fencing prevents stale execution #1 from overwriting in-progress takeover execution #2', async () => {
    const key = 'test-same-payload-fencing-h1';
    const scope = 'POST /__test/idempotent-counter';
    const payload = { value: 42 };

    // Enqueue two sequential gates: one for execution #1, one for execution #2
    const releaseFirst = enqueueTestGate();
    const releaseSecond = enqueueTestGate();

    try {
      // 1. Fire execution #1 (holds gate #1)
      const firstPromise = fetch(`${baseUrl}/__test/idempotent-counter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      });
      await waitForInProgressRow(db, key);

      // 2. Expire execution #1's lock so execution #2 can take over
      await db
        .update(idempotencyKeys)
        .set({ lockedUntil: sql`now() - interval '10 seconds'` })
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));

      // 3. Fire execution #2 with the SAME key and SAME payload (takes over and holds gate #2)
      const secondPromise = fetch(`${baseUrl}/__test/idempotent-counter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      });

      // Wait until execution #2 has taken over (locked_until refreshed into the future)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await db
          .select({
            state: idempotencyKeys.state,
            isFresh: sql<boolean>`${idempotencyKeys.lockedUntil} > now()`,
          })
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
        if (row && row.state === 'in_progress' && row.isFresh) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // 4. Release execution #1 while execution #2 is still in_progress
      releaseFirst();
      const firstRes = await firstPromise;
      expect(firstRes.status).toBe(201);
      expect(firstRes.headers.get('Idempotent-Replayed')).toBeNull();
      expect(await firstRes.json()).toEqual({ count: 1 });

      // Assert the DB row is STILL in_progress (NOT overwritten with #1's response)
      const [rowAfterFirst] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
      expect(rowAfterFirst?.state).toBe('in_progress');
      expect(rowAfterFirst?.responseBody).toBeNull();

      // 5. Release execution #2 -> completes and stores #2's response ({ count: 2 })
      releaseSecond();
      const secondRes = await secondPromise;
      expect(secondRes.status).toBe(201);
      expect(secondRes.headers.get('Idempotent-Replayed')).toBeNull();
      expect(await secondRes.json()).toEqual({ count: 2 });

      const [rowAfterSecond] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
      expect(rowAfterSecond?.state).toBe('completed');
      expect(rowAfterSecond?.responseBody).toEqual({ count: 2 });
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });
});
