import { createHmac } from 'node:crypto';
import {
  appMeta,
  type DatabaseClient,
  eq,
  idempotencyKeys,
  inboxMessages,
  outboxEvents,
  sql,
} from '@internationalota/db';
import { type INestApplication, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { InboxService } from './inbox.service.js';
import { JobQueueService, QUEUE_IDEMPOTENCY_CLEANUP } from './job-queue.service.js';
import { OutboxService } from './outbox.service.js';

const TEST_AUTH_SECRET = 'p1-08-messaging-test-auth-secret-at-least-32-chars';
const TEST_WEBHOOK_SECRET = 'p1-08-test-webhook-hmac-secret-key';

function signWebhookBody(rawBody: string, secret = TEST_WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex')}`;
}

describe('Messaging module integration tests (P1-08)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let outboxService: OutboxService;
  let inboxService: InboxService;
  let jobQueueService: JobQueueService;
  let testDb: TestDbInstance;
  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousWebhookSecret: string | undefined;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousWebhookSecret = process.env['WEBHOOK_TEST_SECRET'];

    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['WEBHOOK_TEST_SECRET'] = TEST_WEBHOOK_SECRET;

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
    outboxService = moduleFixture.get<OutboxService>(OutboxService);
    inboxService = moduleFixture.get<InboxService>(InboxService);
    jobQueueService = moduleFixture.get<JobQueueService>(JobQueueService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = previousDatabaseUrl;
    }
    if (previousAuthSecret === undefined) {
      delete process.env['BETTER_AUTH_SECRET'];
    } else {
      process.env['BETTER_AUTH_SECRET'] = previousAuthSecret;
    }
    if (previousWebhookSecret === undefined) {
      delete process.env['WEBHOOK_TEST_SECRET'];
    } else {
      process.env['WEBHOOK_TEST_SECRET'] = previousWebhookSecret;
    }
    if (testDb) {
      await testDb.teardown();
    }
  });

  beforeEach(async () => {
    outboxService.clearHandlers();
    inboxService.clearHandlers();
    outboxService.resetShutdownForTest();
    inboxService.resetShutdownForTest();
    await db.delete(outboxEvents);
    await db.delete(inboxMessages);
    await db.delete(idempotencyKeys);
  });

  it('AC1: Atomicity - rolled back transaction leaves no outbox row and never calls handler; committed transaction calls handler once', async () => {
    const handledIds: string[] = [];
    outboxService.registerHandler('booking.created', (event) => {
      handledIds.push(event.id);
      return Promise.resolve();
    });

    // 1. Transaction that rolls back
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(appMeta).values({
          key: 'ac1_rolled_back',
          value: { ok: true },
        });
        await outboxService.enqueue(tx, {
          aggregateType: 'booking',
          aggregateId: 'bk-rollback-1',
          eventType: 'booking.created',
          payload: { bookingId: 'bk-rollback-1' },
        });
        throw new Error('Simulated business write failure');
      }),
    ).rejects.toThrow('Simulated business write failure');

    const rowsAfterRollback = await db.select().from(outboxEvents);
    expect(rowsAfterRollback).toHaveLength(0);

    const processedAfterRollback = await outboxService.relayBatch();
    expect(processedAfterRollback).toBe(0);
    expect(handledIds).toHaveLength(0);

    // 2. Transaction that commits
    const committedEvent = await db.transaction(async (tx) => {
      return outboxService.enqueue(tx, {
        aggregateType: 'booking',
        aggregateId: 'bk-commit-1',
        eventType: 'booking.created',
        payload: { bookingId: 'bk-commit-1' },
      });
    });

    const processedAfterCommit = await outboxService.relayBatch();
    expect(processedAfterCommit).toBe(1);
    expect(handledIds).toEqual([committedEvent.id]);

    // Running relay again does not re-dispatch published event
    expect(await outboxService.relayBatch()).toBe(0);
    expect(handledIds).toEqual([committedEvent.id]);

    const [row] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, committedEvent.id));
    expect(row?.publishedAt).not.toBeNull();
  });

  it('AC2: Concurrent relays - 3 relay workers on 50 events handle every event exactly once', async () => {
    const eventCount = 50;
    const countsById = new Map<string, number>();

    outboxService.registerHandler('concurrent.event', async (event) => {
      // Yield so concurrent relay workers overlap while holding row locks
      await new Promise((resolve) => setTimeout(resolve, 5));
      countsById.set(event.id, (countsById.get(event.id) ?? 0) + 1);
    });

    const enqueuedIds: string[] = [];
    await db.transaction(async (tx) => {
      for (let i = 0; i < eventCount; i++) {
        const ev = await outboxService.enqueue(tx, {
          aggregateType: 'order',
          aggregateId: `ord-${i}`,
          eventType: 'concurrent.event',
          payload: { index: i },
        });
        enqueuedIds.push(ev.id);
      }
    });

    // Launch 3 concurrent relay workers draining batches of 10 until empty
    const runWorker = async (): Promise<void> => {
      while (true) {
        const claimed = await outboxService.relayBatch({ batchSize: 10 });
        if (claimed === 0) {
          break;
        }
      }
    };

    await Promise.all([runWorker(), runWorker(), runWorker()]);

    expect(countsById.size).toBe(eventCount);
    for (const id of enqueuedIds) {
      expect(countsById.get(id)).toBe(1);
    }

    const totalExecutions = Array.from(countsById.values()).reduce((sum, n) => sum + n, 0);
    expect(totalExecutions).toBe(eventCount);
  });

  it('AC3: Retry & dead letter - fails twice then succeeds (attempts=2); always fails -> dead-lettered after MAX_ATTEMPTS', async () => {
    // Part A: fails twice then succeeds
    let flakyCalls = 0;
    outboxService.registerHandler('flaky.event', () => {
      flakyCalls += 1;
      if (flakyCalls <= 2) {
        return Promise.reject(new Error(`Transient error #${flakyCalls}`));
      }
      return Promise.resolve();
    });

    const flakyEvent = await db.transaction((tx) =>
      outboxService.enqueue(tx, {
        aggregateType: 'payment',
        aggregateId: 'pay-flaky',
        eventType: 'flaky.event',
        payload: { step: 'charge' },
      }),
    );

    // Attempt 1 (fails -> attempts=1)
    await outboxService.relayBatch({ maxAttempts: 5, baseBackoffMs: 0 });
    const [afterFail1] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, flakyEvent.id));
    expect(afterFail1?.attempts).toBe(1);
    expect(afterFail1?.publishedAt).toBeNull();
    expect(afterFail1?.lastError).toBe('Transient error #1');

    // Attempt 2 (fails -> attempts=2)
    await outboxService.relayBatch({ maxAttempts: 5, baseBackoffMs: 0 });
    const [afterFail2] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, flakyEvent.id));
    expect(afterFail2?.attempts).toBe(2);
    expect(afterFail2?.publishedAt).toBeNull();
    expect(afterFail2?.lastError).toBe('Transient error #2');

    // Attempt 3 (succeeds -> published_at set, attempts remains 2)
    await outboxService.relayBatch({ maxAttempts: 5, baseBackoffMs: 0 });
    const [afterSuccess] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, flakyEvent.id));
    expect(afterSuccess?.attempts).toBe(2);
    expect(afterSuccess?.publishedAt).not.toBeNull();
    expect(afterSuccess?.deadLetteredAt).toBeNull();

    // Part B: always fails -> dead-lettered after MAX_ATTEMPTS (3) and not retried further
    let poisonCalls = 0;
    outboxService.registerHandler('poison.event', () => {
      poisonCalls += 1;
      return Promise.reject(new Error('Permanent downstream failure'));
    });

    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    try {
      const poisonEvent = await db.transaction((tx) =>
        outboxService.enqueue(tx, {
          aggregateType: 'payment',
          aggregateId: 'pay-poison',
          eventType: 'poison.event',
          payload: { step: 'refund' },
        }),
      );

      for (let i = 0; i < 3; i++) {
        await outboxService.relayBatch({ maxAttempts: 3, baseBackoffMs: 0 });
      }

      const [deadRow] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.id, poisonEvent.id));
      expect(deadRow?.attempts).toBe(3);
      expect(deadRow?.publishedAt).toBeNull();
      expect(deadRow?.deadLetteredAt).not.toBeNull();
      expect(deadRow?.lastError).toBe('Permanent downstream failure');
      expect(poisonCalls).toBe(3);

      // Structured ERROR log emitted on dead-lettering
      const errorLogs = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(errorLogs).toContain('outbox_event_dead_lettered');
      expect(errorLogs).toContain(poisonEvent.id);

      // Subsequent relay does NOT retry dead-lettered event
      expect(await outboxService.relayBatch({ maxAttempts: 3, baseBackoffMs: 0 })).toBe(0);
      expect(poisonCalls).toBe(3);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('AC4: Crash between handler execution and marking published_at causes at-least-once redelivery', async () => {
    let deliveryCount = 0;
    outboxService.registerHandler('crash.event', () => {
      deliveryCount += 1;
      return Promise.resolve();
    });

    const event = await db.transaction((tx) =>
      outboxService.enqueue(tx, {
        aggregateType: 'booking',
        aggregateId: 'bk-crash-1',
        eventType: 'crash.event',
        payload: { id: 'bk-crash-1' },
      }),
    );

    // Simulate process crash AFTER handler executed, BEFORE published_at is persisted
    await expect(
      outboxService.relayBatch({
        afterHandleHook: () => {
          throw new Error('Simulated crash before marking published_at');
        },
      }),
    ).rejects.toThrow('Simulated crash before marking published_at');

    expect(deliveryCount).toBe(1);
    const [rowAfterCrash] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, event.id));
    expect(rowAfterCrash?.publishedAt).toBeNull();

    // Next relay tick redelivers the event and commits published_at (at-least-once guarantee)
    expect(await outboxService.relayBatch()).toBe(1);
    expect(deliveryCount).toBe(2);
    const [rowAfterRetry] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, event.id));
    expect(rowAfterRetry?.publishedAt).not.toBeNull();
  });

  it('AC5: Webhook inbox - deduplicates sequential & concurrent deliveries, verifies raw bytes, rejects invalid/tampered/unknown, never logs payload', async () => {
    const processedEventIds: string[] = [];
    inboxService.registerHandler('test', (msg) => {
      processedEventIds.push(msg.providerEventId);
      return Promise.resolve();
    });

    const logSpy = vi.spyOn(Logger.prototype, 'log');
    try {
      // 1. Same signed event sent 5 times sequentially -> 1 row, all 200, processed once
      const seqRawBody =
        '{"id":"evt-seq-001","customerEmail":"pii-secret@example.com","amount":500}';
      const seqSig = signWebhookBody(seqRawBody);

      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${baseUrl}/webhooks/test`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': seqSig,
          },
          body: seqRawBody,
        });
        expect(res.status).toBe(200);
      }

      // 2. Another signed event sent 5 times concurrently -> 1 row, all 200, processed once
      const concRawBody = '{"id":"evt-conc-001","type":"payment.settled"}';
      const concSig = signWebhookBody(concRawBody);

      const concResponses = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetch(`${baseUrl}/webhooks/test`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': concSig,
            },
            body: concRawBody,
          }),
        ),
      );
      for (const res of concResponses) {
        expect(res.status).toBe(200);
      }

      // Verify exactly 2 deduplicated inbox rows exist
      const storedBeforeRelay = await db.select().from(inboxMessages);
      expect(storedBeforeRelay).toHaveLength(2);

      // Process inbox asynchronously -> each event handled exactly once
      const processedCount = await inboxService.relayBatch();
      expect(processedCount).toBe(2);
      expect(processedEventIds.sort()).toEqual(['evt-conc-001', 'evt-seq-001']);

      // Re-running relay does not reprocess
      expect(await inboxService.relayBatch()).toBe(0);

      // Verify full payload (PII) was NEVER logged at INFO
      const infoLogs = logSpy.mock.calls.flat().map(String).join('\n');
      expect(infoLogs).not.toContain('pii-secret@example.com');

      // 3. Wrong signature -> 401 problem+json, nothing stored
      const wrongSigRes = await fetch(`${baseUrl}/webhooks/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${'0'.repeat(64)}`,
        },
        body: '{"id":"evt-bad-sig"}',
      });
      expect(wrongSigRes.status).toBe(401);
      expect(wrongSigRes.headers.get('Content-Type')).toContain('application/problem+json');

      // 4. Tampered body -> 401 problem+json, nothing stored
      const origBody = '{"id":"evt-tamper","amount":100}';
      const origSig = signWebhookBody(origBody);
      const tamperedRes = await fetch(`${baseUrl}/webhooks/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': origSig,
        },
        body: '{"id":"evt-tamper","amount":999}',
      });
      expect(tamperedRes.status).toBe(401);

      // 5. Raw-bytes verification: re-serialized JSON with different whitespace MUST fail 401
      const spacedJson = '{ "id": "evt-ws", "amount": 100 }';
      const compactJson = '{"id":"evt-ws","amount":100}';
      const spacedSig = signWebhookBody(spacedJson);
      const wsRes = await fetch(`${baseUrl}/webhooks/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': spacedSig,
        },
        body: compactJson,
      });
      expect(wsRes.status).toBe(401);

      // 6. Unknown provider -> 404 problem+json, nothing stored
      const unknownRes = await fetch(`${baseUrl}/webhooks/unknown-provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"id":"evt-unknown"}',
      });
      expect(unknownRes.status).toBe(404);
      expect(unknownRes.headers.get('Content-Type')).toContain('application/problem+json');

      // Confirm NO invalid rows were stored (still only the 2 valid rows)
      const storedAfterInvalid = await db.select().from(inboxMessages);
      expect(storedAfterInvalid).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('AC6: Scheduled cleanup job (idempotency-keys-cleanup via pg-boss) deletes only expired idempotency rows', async () => {
    const scope = 'POST /__test/cleanup';
    const hash = 'a'.repeat(64);

    await db.insert(idempotencyKeys).values([
      {
        scope,
        key: 'expired-key-1',
        requestHash: hash,
        state: 'completed',
        responseStatus: 200,
        responseBody: { ok: true },
        lockedUntil: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      },
      {
        scope,
        key: 'active-key-1',
        requestHash: hash,
        state: 'completed',
        responseStatus: 200,
        responseBody: { ok: true },
        lockedUntil: sql`now() + interval '60 seconds'`,
        expiresAt: sql`now() + interval '24 hours'`,
      },
    ]);

    // Enqueue cleanup job through pg-boss
    const jobId = await jobQueueService.sendJob(QUEUE_IDEMPOTENCY_CLEANUP);
    expect(jobId).toBeTruthy();

    // Poll until pg-boss worker executes the cleanup job and deletes the expired row
    const deadline = Date.now() + 10_000;
    let remaining: Array<{ key: string }> = [];
    while (Date.now() < deadline) {
      remaining = await db.select({ key: idempotencyKeys.key }).from(idempotencyKeys);
      if (remaining.length === 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(remaining.map((r) => r.key)).toEqual(['active-key-1']);
  });

  it('AC7: Graceful shutdown completes in-flight handler and refuses new claims after shutdown starts', async () => {
    const shutdownFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const shutdownApp = shutdownFixture.createNestApplication({ bodyParser: false });
    configureApp(shutdownApp);
    await shutdownApp.init();

    const localDb = shutdownFixture.get<DatabaseClient>(DRIZZLE_DB);
    const localOutbox = shutdownFixture.get<OutboxService>(OutboxService);

    let handlerStartedResolve!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerStartedResolve = resolve;
    });

    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const handledIds: string[] = [];
    localOutbox.registerHandler('shutdown.event', async (event) => {
      handlerStartedResolve();
      await handlerGate;
      handledIds.push(event.id);
    });

    const [event1, event2] = await localDb.transaction(async (tx) => {
      const e1 = await localOutbox.enqueue(tx, {
        aggregateType: 'job',
        aggregateId: 'job-1',
        eventType: 'shutdown.event',
        payload: { seq: 1 },
      });
      const e2 = await localOutbox.enqueue(tx, {
        aggregateType: 'job',
        aggregateId: 'job-2',
        eventType: 'shutdown.event',
        payload: { seq: 2 },
      });
      return [e1, e2];
    });

    // Start claiming event1 (in-flight)
    const inFlightRelay = localOutbox.relayBatch({ batchSize: 1 });
    await handlerStarted;

    // Begin graceful shutdown while event1 is still in-flight
    const closePromise = shutdownApp.close();

    // Wait briefly for onApplicationShutdown to mark shuttingDown=true
    const deadline = Date.now() + 2000;
    while (!localOutbox.isShuttingDown() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(localOutbox.isShuttingDown()).toBe(true);

    // Attempting to claim event2 after shutdown started must return 0
    expect(await localOutbox.relayBatch({ batchSize: 1 })).toBe(0);

    // Release in-flight handler -> shutdown finishes cleanly
    releaseHandler();
    await inFlightRelay;
    await closePromise;

    expect(handledIds).toEqual([event1.id]);

    // Verify event1 is published and event2 was NOT claimed
    const [row1] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event1.id));
    const [row2] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event2.id));
    expect(row1?.publishedAt).not.toBeNull();
    expect(row2?.publishedAt).toBeNull();
  });
});
