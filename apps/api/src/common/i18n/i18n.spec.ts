import { PassThrough } from 'node:stream';
import { seedReferenceData } from '@internationalota/db';
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { LedgerUnbalancedError } from '../../modules/finance/index.js';
import { Idempotent } from '../../modules/idempotency/index.js';
import { AuthGuard, IdentityModule } from '../../modules/identity/index.js';
import { createPinoLogger } from '../observability/logger.js';

const TEST_AUTH_SECRET = 'p1-11-i18n-test-auth-secret-32-chars-min';

@Controller('__test/i18n')
class TestI18nController {
  @Get('protected')
  @UseGuards(AuthGuard)
  protectedEndpoint(): { ok: true } {
    return { ok: true };
  }

  @Post('idempotent')
  @Idempotent()
  idempotentEndpoint(): { created: true } {
    return { created: true };
  }

  @Get('explicit-i18n-key')
  throwExplicitKey(): never {
    throw new BadRequestException({
      message: 'Unlocalized fallback text that must be replaced by i18nKey',
      i18nKey: 'http.404.unknownWebhookProvider',
      i18nParams: { provider: 'demo-pay' },
    });
  }

  @Get('ledger-unbalanced')
  throwLedgerUnbalanced(): never {
    throw new LedgerUnbalancedError('VND', 1000n, 500n);
  }

  @Get('boom')
  throwInternal(): never {
    throw new Error('Unexpected database timeout');
  }
}

describe('API i18n & localized ProblemDetails integration tests (P1-11)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let testDb: TestDbInstance;
  let rawLogs = '';

  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env['BETTER_AUTH_SECRET'];
    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    testDb = await createTestDatabase();
    await seedReferenceData(testDb.db);

    const logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) => {
      rawLogs += chunk.toString('utf8');
    });
    const testLogger = createPinoLogger({ destination: logStream, level: 'info' });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, IdentityModule],
      controllers: [TestI18nController],
    })
      .overrideProvider(DRIZZLE_DB)
      .useValue(testDb.db)
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, { logger: testLogger });
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.teardown();
    if (previousSecret === undefined) {
      delete process.env['BETTER_AUTH_SECRET'];
    } else {
      process.env['BETTER_AUTH_SECRET'] = previousSecret;
    }
  }, 30_000);

  it('AC2 (401): returns Vietnamese with Accept-Language: vi and English with en; identical type; Content-Language set', async () => {
    const resVi = await fetch(`${baseUrl}/__test/i18n/protected`, {
      headers: { 'Accept-Language': 'vi' },
    });
    const bodyVi = (await resVi.json()) as Record<string, unknown>;

    const resEn = await fetch(`${baseUrl}/__test/i18n/protected`, {
      headers: { 'Accept-Language': 'en' },
    });
    const bodyEn = (await resEn.json()) as Record<string, unknown>;

    expect(resVi.status).toBe(401);
    expect(resEn.status).toBe(401);
    expect(resVi.headers.get('content-language')).toBe('vi');
    expect(resEn.headers.get('content-language')).toBe('en');
    expect(bodyVi['type']).toBe('https://httpstatuses.com/401');
    expect(bodyEn['type']).toBe(bodyVi['type']);
    expect(bodyVi['title']).toBe('Chưa xác thực');
    expect(bodyEn['title']).toBe('Unauthorized');
    expect(bodyVi['detail']).toBe('Vui lòng đăng nhập để tiếp tục.');
    expect(bodyEn['detail']).toBe('Authentication required.');
  });

  it('AC2 (413): oversized webhook payload returns localized title & detail in vi and en with identical type', async () => {
    const oversized = 'x'.repeat(1_048_576 + 100);

    const resVi = await fetch(`${baseUrl}/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'vi' },
      body: oversized,
    });
    const bodyVi = (await resVi.json()) as Record<string, unknown>;

    const resEn = await fetch(`${baseUrl}/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
      body: oversized,
    });
    const bodyEn = (await resEn.json()) as Record<string, unknown>;

    expect(resVi.status).toBe(413);
    expect(resEn.status).toBe(413);
    expect(resVi.headers.get('content-language')).toBe('vi');
    expect(resEn.headers.get('content-language')).toBe('en');
    expect(bodyVi['type']).toBe('https://httpstatuses.com/413');
    expect(bodyEn['type']).toBe(bodyVi['type']);
    expect(bodyVi['title']).toBe('Dữ liệu quá lớn');
    expect(bodyEn['title']).toBe('Payload Too Large');
    expect(String(bodyVi['detail'])).toContain('vượt quá giới hạn');
    expect(String(bodyEn['detail'])).toContain('exceeds maximum allowed size');
  });

  it('AC2 (422): idempotency key reuse returns localized Vietnamese and English errors with identical type', async () => {
    const key = `i18n-reuse-${Date.now()}`;

    const first = await fetch(`${baseUrl}/__test/i18n/idempotent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(first.status).toBe(201);

    const resVi = await fetch(`${baseUrl}/__test/i18n/idempotent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'Accept-Language': 'vi',
      },
      body: JSON.stringify({ amount: 200 }),
    });
    const bodyVi = (await resVi.json()) as Record<string, unknown>;

    const resEn = await fetch(`${baseUrl}/__test/i18n/idempotent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'Accept-Language': 'en',
      },
      body: JSON.stringify({ amount: 300 }),
    });
    const bodyEn = (await resEn.json()) as Record<string, unknown>;

    expect(resVi.status).toBe(422);
    expect(resEn.status).toBe(422);
    expect(resVi.headers.get('content-language')).toBe('vi');
    expect(resEn.headers.get('content-language')).toBe('en');
    expect(bodyVi['type']).toBe('https://httpstatuses.com/422');
    expect(bodyEn['type']).toBe(bodyVi['type']);
    expect(bodyVi['title']).toBe('Không thể xử lý dữ liệu');
    expect(bodyEn['title']).toBe('Unprocessable Entity');
    expect(bodyVi['detail']).toBe(
      'Khóa chống trùng lặp đã được sử dụng trước đó với nội dung yêu cầu khác.',
    );
    expect(bodyEn['detail']).toBe(
      'Idempotency key was previously used with a different request payload.',
    );
  });

  it('resolves ?lang= query precedence over Accept-Language and rejects disabled languages (ko) from reference.languages', async () => {
    const resQueryEn = await fetch(`${baseUrl}/__test/i18n/ledger-unbalanced?lang=en`, {
      headers: { 'Accept-Language': 'vi' },
    });
    const bodyQueryEn = (await resQueryEn.json()) as Record<string, unknown>;
    expect(resQueryEn.status).toBe(422);
    expect(resQueryEn.headers.get('content-language')).toBe('en');
    expect(bodyQueryEn['detail']).toBe('Journal entry is unbalanced for currency VND.');

    // ko is disabled in reference.languages -> falls back to default ('vi')
    const resDisabledKo = await fetch(`${baseUrl}/__test/i18n/ledger-unbalanced?lang=ko`, {
      headers: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
    const bodyDisabledKo = (await resDisabledKo.json()) as Record<string, unknown>;
    expect(resDisabledKo.status).toBe(422);
    expect(resDisabledKo.headers.get('content-language')).toBe('vi');
    expect(bodyDisabledKo['detail']).toBe('Bút toán kế toán không cân đối cho loại tiền tệ VND.');
  });

  it('keeps server-side error logs in English even when HTTP response is Vietnamese', async () => {
    rawLogs = '';
    const res = await fetch(`${baseUrl}/__test/i18n/boom`, {
      headers: { 'Accept-Language': 'vi' },
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(500);
    expect(res.headers.get('content-language')).toBe('vi');
    expect(body['title']).toBe('Lỗi máy chủ nội bộ');
    expect(body['detail']).toBe('Đã xảy ra lỗi nội bộ ngoài ý muốn.');

    // Server log remains English
    expect(rawLogs).toContain('http_server_error');
    expect(rawLogs).toContain('Unexpected database timeout');
  });

  it('I2: localizes explicit i18nKey + i18nParams and unknown webhook provider / missing idempotency key in vi and en', async () => {
    const resExplicitVi = await fetch(`${baseUrl}/__test/i18n/explicit-i18n-key`, {
      headers: { 'Accept-Language': 'vi' },
    });
    const bodyExplicitVi = (await resExplicitVi.json()) as Record<string, unknown>;
    expect(resExplicitVi.status).toBe(400);
    expect(bodyExplicitVi['detail']).toBe('Nhà cung cấp webhook không được hỗ trợ: demo-pay.');

    const resExplicitEn = await fetch(`${baseUrl}/__test/i18n/explicit-i18n-key`, {
      headers: { 'Accept-Language': 'en' },
    });
    const bodyExplicitEn = (await resExplicitEn.json()) as Record<string, unknown>;
    expect(resExplicitEn.status).toBe(400);
    expect(bodyExplicitEn['detail']).toBe('Unknown webhook provider: demo-pay.');

    const resMissingKeyVi = await fetch(`${baseUrl}/__test/i18n/idempotent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'vi' },
      body: JSON.stringify({ amount: 1 }),
    });
    const bodyMissingKeyVi = (await resMissingKeyVi.json()) as Record<string, unknown>;
    expect(resMissingKeyVi.status).toBe(400);
    expect(bodyMissingKeyVi['detail']).toContain('Idempotency-Key');

    const resUnknownProvVi = await fetch(`${baseUrl}/webhooks/missing-provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'vi' },
      body: JSON.stringify({ id: 'evt-1' }),
    });
    const bodyUnknownProvVi = (await resUnknownProvVi.json()) as Record<string, unknown>;
    expect(resUnknownProvVi.status).toBe(404);
    expect(bodyUnknownProvVi['detail']).toBe(
      'Nhà cung cấp webhook không được hỗ trợ: missing-provider.',
    );
  });
});
