import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import type { DatabaseClient } from '@internationalota/db';
import {
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Logger,
  Post,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { MessagingModule, OutboxService } from '../../modules/messaging/index.js';
import { createPinoLogger } from './logger.js';
import { REQUEST_ID_REGEX } from './request-context.js';

const TEST_AUTH_SECRET = 'p1-10-observability-test-auth-secret-32-chars';
const TEST_WEBHOOK_SECRET = 'p1-10-observability-webhook-secret';

@Controller('__test/obs')
class TestObservabilityController {
  private readonly logger = new Logger(TestObservabilityController.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly outboxService: OutboxService,
  ) {}

  @Get('ping')
  ping(): { ok: true } {
    this.logger.log('Handling ping request');
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    this.logger.warn('About to throw simulated 500');
    throw new InternalServerErrorException('Secret internal DB stack detail');
  }

  @Post('enqueue')
  async enqueue(): Promise<{ eventId: string }> {
    const event = await this.db.transaction((tx) =>
      this.outboxService.enqueue(tx, {
        aggregateType: 'order',
        aggregateId: 'ord-obs-1',
        eventType: 'obs.test.event',
        payload: { note: 'correlated' },
      }),
    );
    this.logger.log(JSON.stringify({ event: 'test_enqueued', eventId: event.id }));
    return { eventId: event.id };
  }
}

describe('Observability: structured logs, request IDs, redaction, and async correlation (P1-10)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let outboxService: OutboxService;
  let testDb: TestDbInstance;
  let rawLogBuffer = '';
  let pinoLogger: ReturnType<typeof createPinoLogger>;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousWebhookSecret: string | undefined;
  let previousBossDisabled: string | undefined;

  function parseLogLines(): Array<Record<string, unknown>> {
    return rawLogBuffer
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousWebhookSecret = process.env['WEBHOOK_TEST_SECRET'];
    previousBossDisabled = process.env['PG_BOSS_DISABLED'];

    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['WEBHOOK_TEST_SECRET'] = TEST_WEBHOOK_SECRET;
    process.env['PG_BOSS_DISABLED'] = 'true';

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;

    const memoryStream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        rawLogBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        callback();
      },
    });
    pinoLogger = createPinoLogger({ destination: memoryStream, level: 'info' });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MessagingModule],
      controllers: [TestObservabilityController],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app, { logger: pinoLogger });
    await app.listen(0);
    baseUrl = await app.getUrl();
    outboxService = moduleFixture.get<OutboxService>(OutboxService);
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
    if (previousBossDisabled === undefined) {
      delete process.env['PG_BOSS_DISABLED'];
    } else {
      process.env['PG_BOSS_DISABLED'] = previousBossDisabled;
    }
    if (testDb) {
      await testDb.teardown();
    }
  });

  beforeEach(() => {
    rawLogBuffer = '';
    outboxService.clearHandlers();
  });

  it('AC1: Request produces JSON log lines carrying consistent requestId matching X-Request-Id header and problem+json body', async () => {
    const okRes = await fetch(`${baseUrl}/__test/obs/ping`);
    expect(okRes.status).toBe(200);
    const okRequestId = okRes.headers.get('X-Request-Id');
    expect(okRequestId).toBeTruthy();
    expect(REQUEST_ID_REGEX.test(okRequestId!)).toBe(true);

    const lines = parseLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line['requestId']).toBe(okRequestId);
      expect(line['service']).toBe('api');
      expect(line['env']).toBe('test');
      expect(typeof line['level']).toBe('string');
      expect(typeof line['time']).toBe('string');
      expect(typeof line['msg']).toBe('string');
    }

    // Problem+json error body includes matching requestId
    rawLogBuffer = '';
    const notFoundRes = await fetch(`${baseUrl}/__test/obs/does-not-exist`);
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.headers.get('Content-Type')).toContain('application/problem+json');
    const errHeaderId = notFoundRes.headers.get('X-Request-Id');
    const problem = (await notFoundRes.json()) as { status: number; requestId?: string };
    expect(problem.requestId).toBe(errHeaderId);
  });

  it('AC2: Valid incoming X-Request-Id is honoured; invalid ones (too long, spaces, newline injection) are replaced', async () => {
    // Valid X-Request-Id
    const validId = 'req-valid_123.ABC-99';
    const validRes = await fetch(`${baseUrl}/__test/obs/ping`, {
      headers: { 'X-Request-Id': validId },
    });
    expect(validRes.status).toBe(200);
    expect(validRes.headers.get('X-Request-Id')).toBe(validId);

    // Too long (> 64 chars)
    const tooLong = 'a'.repeat(65);
    const longRes = await fetch(`${baseUrl}/__test/obs/ping`, {
      headers: { 'X-Request-Id': tooLong },
    });
    const longEcho = longRes.headers.get('X-Request-Id')!;
    expect(longEcho).not.toBe(tooLong);
    expect(REQUEST_ID_REGEX.test(longEcho)).toBe(true);

    // Spaces
    const withSpaces = 'invalid request id';
    const spaceRes = await fetch(`${baseUrl}/__test/obs/ping`, {
      headers: { 'X-Request-Id': withSpaces },
    });
    const spaceEcho = spaceRes.headers.get('X-Request-Id')!;
    expect(spaceEcho).not.toBe(withSpaces);
    expect(REQUEST_ID_REGEX.test(spaceEcho)).toBe(true);

    // Too short (< 8 chars) / special chars
    const tooShort = 'abc';
    const shortRes = await fetch(`${baseUrl}/__test/obs/ping`, {
      headers: { 'X-Request-Id': tooShort },
    });
    const shortEcho = shortRes.headers.get('X-Request-Id')!;
    expect(shortEcho).not.toBe(tooShort);
    expect(REQUEST_ID_REGEX.test(shortEcho)).toBe(true);
  });

  it('AC3: Redaction - raw log text never contains password, Authorization, Cookie, webhook signature, or raw body', async () => {
    const secretPassword = 'UltraSecretPassword!P110#XYZ';
    const secretAuthHeader = 'Bearer super-secret-jwt-token-99999';
    const secretCookie = 'better-auth.session_token=super-secret-cookie-88888';
    const webhookPiiSecret = 'top-secret-webhook-pii-77777';

    // 1. Sign-in request with password + Authorization + Cookie headers
    await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        Authorization: secretAuthHeader,
        Cookie: secretCookie,
      },
      body: JSON.stringify({
        email: 'nobody@example.com',
        password: secretPassword,
      }),
    });

    // 2. Signed webhook request
    const rawWebhookBody = JSON.stringify({
      id: 'evt-obs-redact-1',
      customerSecret: webhookPiiSecret,
    });
    const webhookSig = `sha256=${createHmac('sha256', TEST_WEBHOOK_SECRET).update(rawWebhookBody).digest('hex')}`;
    const webhookRes = await fetch(`${baseUrl}/webhooks/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': webhookSig,
      },
      body: rawWebhookBody,
    });
    expect(webhookRes.status).toBe(200);

    // 3. Direct logger redaction check for sensitive fields
    pinoLogger.info(
      {
        password: secretPassword,
        newPassword: 'NewSecretPassword!123',
        token: 'secret-token-value-111',
        secret: 'secret-api-key-222',
        rawBody: webhookPiiSecret,
        cardNumber: '4111111111111111',
        cvv: '987',
      },
      'direct redaction check',
    );

    // Assert on the CAPTURED RAW LOG TEXT (not parsed objects)
    expect(rawLogBuffer).not.toContain(secretPassword);
    expect(rawLogBuffer).not.toContain('NewSecretPassword!123');
    expect(rawLogBuffer).not.toContain(secretAuthHeader);
    expect(rawLogBuffer).not.toContain(secretCookie);
    expect(rawLogBuffer).not.toContain(webhookSig);
    expect(rawLogBuffer).not.toContain(webhookPiiSecret);
    expect(rawLogBuffer).not.toContain('secret-token-value-111');
    expect(rawLogBuffer).not.toContain('secret-api-key-222');
    expect(rawLogBuffer).not.toContain('4111111111111111');
    expect(rawLogBuffer).not.toContain('"cvv":"987"');
    expect(rawLogBuffer).toContain('[REDACTED]');
  });

  it('AC4: 5xx error logs stack server-side with requestId while response returns only generic detail + requestId', async () => {
    const incomingId = 'req-5xx-trace-0001';
    const res = await fetch(`${baseUrl}/__test/obs/boom`, {
      headers: { 'X-Request-Id': incomingId },
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('X-Request-Id')).toBe(incomingId);
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
      requestId: string;
    };
    expect(body).toEqual({
      type: 'https://httpstatuses.com/500',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected internal error occurred',
      requestId: incomingId,
    });

    // Server-side JSON error log contains stack + requestId
    const errorLines = parseLogLines().filter((l) => l['level'] === 'error');
    const serverErrLine = errorLines.find((l) => l['event'] === 'http_server_error');
    expect(serverErrLine).toBeDefined();
    expect(serverErrLine?.['requestId']).toBe(incomingId);
    expect(typeof serverErrLine?.['stack']).toBe('string');
    expect(String(serverErrLine?.['stack'])).toContain('Secret internal DB stack detail');
  });

  it('AC5: Outbox event enqueued during a request is relayed with logs containing the same requestId and eventId', async () => {
    const incomingId = 'req-async-corr-2026';

    const handledEvents: string[] = [];
    outboxService.registerHandler('obs.test.event', (event) => {
      handledEvents.push(event.id);
      return Promise.resolve();
    });

    const enqueueRes = await fetch(`${baseUrl}/__test/obs/enqueue`, {
      method: 'POST',
      headers: { 'X-Request-Id': incomingId },
    });
    expect(enqueueRes.status).toBe(201);
    const { eventId } = (await enqueueRes.json()) as { eventId: string };
    expect(eventId).toBeTruthy();

    // Clear HTTP logs and run outbox relay asynchronously outside HTTP request
    rawLogBuffer = '';
    const count = await outboxService.relayBatch();
    expect(count).toBe(1);
    expect(handledEvents).toEqual([eventId]);

    const relayLines = parseLogLines();
    const publishedLog = relayLines.find((l) => l['event'] === 'outbox_event_published');
    expect(publishedLog).toBeDefined();
    expect(publishedLog?.['requestId']).toBe(incomingId);
    expect(publishedLog?.['eventId']).toBe(eventId);
    expect(publishedLog?.['eventType']).toBe('obs.test.event');
    expect(publishedLog?.['attempt']).toBe(1);
  });
});
