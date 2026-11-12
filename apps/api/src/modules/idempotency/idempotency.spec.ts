import { appMeta, type DatabaseClient, idempotencyKeys } from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { DRIZZLE_DB } from '../../database/database.module.js';

describe('Idempotency module integration tests', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || 'postgresql://ota_user:ota_password@localhost:55432/ota_dev';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Clean up test rows in platform schema before each test
    await db.delete(idempotencyKeys);
    await db.delete(appMeta).where(eq(appMeta.key, 'test_idempotent_counter'));
  });

  it('Criterion 1: Concurrency - 20 parallel requests increment counter exactly once', async () => {
    const key = 'test-concurrent-key-001';
    const payload = { action: 'increment', step: 1 };

    // Fire 20 parallel requests simultaneously
    const requests = Array.from({ length: 20 }, () =>
      fetch(`${baseUrl}/__test/idempotent-counter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      }),
    );

    const responses = await Promise.all(requests);

    let original2xxCount = 0;
    let replayCount = 0;
    let conflict409Count = 0;

    for (const res of responses) {
      if (res.status === 201 || res.status === 200) {
        const isReplay = res.headers.get('Idempotent-Replayed') === 'true';
        if (isReplay) {
          replayCount++;
        } else {
          original2xxCount++;
        }
        const data = (await res.json()) as { count: number };
        expect(data.count).toBe(1);
      } else if (res.status === 409) {
        conflict409Count++;
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
      } else {
        throw new Error(`Unexpected status code: ${res.status}`);
      }
    }

    // Exactly one original execution took place
    expect(original2xxCount).toBe(1);
    expect(original2xxCount + replayCount + conflict409Count).toBe(20);

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
});
