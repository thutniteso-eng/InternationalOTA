import { Writable } from 'node:stream';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initTracing, shutdownTracing } from '../../tracing.js';

const TEST_AUTH_SECRET = 'p1-10-tracing-test-auth-secret-at-least-32-chars';

describe('OpenTelemetry tracing integration test (P1-10 AC6)', () => {
  const spanExporter = new InMemorySpanExporter();
  let rawLogBuffer = '';

  let app: import('@nestjs/common').INestApplication;
  let baseUrl: string;
  let testDb: import('../../../test/test-db.js').TestDbInstance;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousBossDisabled: string | undefined;

  beforeAll(async () => {
    // Initialize OTel BEFORE importing pg / express / NestJS app modules
    initTracing({ spanExporter, forceEnable: true });

    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousBossDisabled = process.env['PG_BOSS_DISABLED'];

    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['PG_BOSS_DISABLED'] = 'true';

    const { createTestDatabase } = await import('../../../test/test-db.js');
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../../app.module.js');
    const { configureApp } = await import('../../app.setup.js');
    const { createPinoLogger } = await import('./logger.js');

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;

    const memoryStream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        rawLogBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        callback();
      },
    });
    const pinoLogger = createPinoLogger({ destination: memoryStream, level: 'info' });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app, { logger: pinoLogger });
    await app.listen(0);
    baseUrl = await app.getUrl();
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
    if (previousBossDisabled === undefined) {
      delete process.env['PG_BOSS_DISABLED'];
    } else {
      process.env['PG_BOSS_DISABLED'] = previousBossDisabled;
    }
    if (testDb) {
      await testDb.teardown();
    }
    await shutdownTracing();
  }, 30_000);

  it('AC6: HTTP request querying DB yields an HTTP server span with a child pg span sharing traceId, and logs carry that traceId', async () => {
    spanExporter.reset();
    rawLogBuffer = '';

    const res = await fetch(`${baseUrl}/health/ready`, {
      headers: {
        'X-Request-Id': 'req-otel-trace-01',
        Connection: 'close',
      },
    });
    expect(res.status).toBe(200);
    await res.json();

    const spans = spanExporter.getFinishedSpans();

    // Find HTTP server span
    const httpServerSpan = spans.find((s) => {
      const target = s.attributes['http.target'];
      const urlPath = s.attributes['url.path'];
      return (
        Number(s.kind) === Number(SpanKind.SERVER) &&
        ((typeof target === 'string' && target.includes('/health/ready')) ||
          (typeof urlPath === 'string' && urlPath.includes('/health/ready')) ||
          s.name.includes('GET'))
      );
    });
    expect(httpServerSpan).toBeDefined();

    const traceId = httpServerSpan!.spanContext().traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    // Find child pg span sharing the exact same traceId
    const pgSpan = spans.find(
      (s) =>
        s.spanContext().traceId === traceId &&
        (s.name.startsWith('pg.') || s.attributes['db.system'] === 'postgresql'),
    );
    expect(pgSpan).toBeDefined();

    // Assert logs emitted during the request carry that exact traceId
    const logLines = rawLogBuffer
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const requestLog = logLines.find((l) => l['requestId'] === 'req-otel-trace-01');
    expect(requestLog).toBeDefined();
    expect(requestLog?.['traceId']).toBe(traceId);
  });
});
