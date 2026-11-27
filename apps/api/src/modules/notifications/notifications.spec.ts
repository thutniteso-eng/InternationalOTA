import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { Writable } from 'node:stream';
import {
  applyRuntimeRoleGrants,
  createDbClient,
  type DatabaseClient,
  eq,
  grantRoleByEmail,
  notificationsEmailMessages,
  outboxEvents,
  seedReferenceData,
} from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { createPinoLogger } from '../../common/observability/logger.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { BookingService, type HoldBookingResponseDto } from '../booking/index.js';
import type { AdminCatalogProductDto } from '../catalog/index.js';
import { EMAIL_SENDER, type EmailSender } from '../identity/index.js';
import type { GenerateDeparturesResult } from '../inventory/index.js';
import { InboxService, OutboxService } from '../messaging/index.js';
import {
  type InitiateCheckoutResponseDto,
  MockPaymentProvider,
  RefundService,
} from '../payments/index.js';
import type { PublicQuoteResponse } from '../pricing/index.js';
import type { SupplierRecord } from '../supply/index.js';
import { EMAIL_TRANSPORT, LogEmailTransport, NotificationsService } from './index.js';

const TEST_AUTH_SECRET = 'p2-08-notifications-auth-secret-key-min-32-chars';
const TEST_MOCK_PSP_SECRET = 'p2-08-mock-psp-secret-key-at-least-32-chars-001';

interface CapturedSmtpMessage {
  readonly from: string;
  readonly to: string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly raw: string;
}

function decodeRfc2047Word(encoded: string): string {
  return encoded.replace(
    /=\?utf-8\?([bqBQ])\?([^?]+)\?=/g,
    (_full, encoding: string, data: string) => {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(data, 'base64').toString('utf8');
      }
      const bytes: number[] = [];
      const normalized = data.replaceAll('_', ' ');
      for (let i = 0; i < normalized.length; i++) {
        if (normalized[i] === '=' && i + 2 < normalized.length) {
          bytes.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(...Buffer.from(normalized[i]!, 'utf8'));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    },
  );
}

function decodeQuotedPrintable(body: string): string {
  const unfolded = body.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(unfolded[i]!, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBodyTransfer(headersRaw: string, bodyRaw: string): string {
  const encMatch = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(headersRaw);
  const enc = encMatch?.[1]?.trim().toLowerCase() ?? '7bit';
  if (enc === 'base64') {
    return Buffer.from(bodyRaw.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(bodyRaw);
  }
  return bodyRaw;
}

function parseMimeRawEmail(raw: string): { subject: string; text: string; html: string } {
  const splitIdx = raw.indexOf('\r\n\r\n');
  const headerBlock = splitIdx >= 0 ? raw.slice(0, splitIdx) : raw;
  const bodyBlock = splitIdx >= 0 ? raw.slice(splitIdx + 4) : '';
  const unfoldedHeaders = headerBlock.replace(/\r\n[ \t]+/g, ' ');

  const subjMatch = /^subject:\s*(.+)$/im.exec(unfoldedHeaders);
  const subject = subjMatch ? decodeRfc2047Word(subjMatch[1]!.trim()) : '';

  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/i.exec(unfoldedHeaders);
  if (!boundaryMatch) {
    const decoded = decodeBodyTransfer(unfoldedHeaders, bodyBlock);
    return /content-type:\s*text\/html/i.test(unfoldedHeaders)
      ? { subject, text: '', html: decoded }
      : { subject, text: decoded, html: '' };
  }

  const boundary = boundaryMatch[1]!;
  const sections = bodyBlock.split(`--${boundary}`);
  let text = '';
  let html = '';

  for (const section of sections) {
    if (!section || section.startsWith('--')) {
      continue;
    }
    const cleanSec = section.startsWith('\r\n') ? section.slice(2) : section;
    const secSplit = cleanSec.indexOf('\r\n\r\n');
    if (secSplit < 0) {
      continue;
    }
    const secHeaders = cleanSec.slice(0, secSplit);
    const secBody = cleanSec.slice(secSplit + 4).replace(/\r\n$/, '');
    if (/content-type:\s*text\/plain/i.test(secHeaders)) {
      text = decodeBodyTransfer(secHeaders, secBody);
    } else if (/content-type:\s*text\/html/i.test(secHeaders)) {
      html = decodeBodyTransfer(secHeaders, secBody);
    }
  }

  return { subject, text, html };
}

class LocalSmtpTestServer {
  readonly messages: CapturedSmtpMessage[] = [];
  private readonly server: net.Server;
  private failRemaining = 0;
  private failCodeLine = '421 4.3.2 Service temporarily unavailable';
  port = 0;

  constructor() {
    this.server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let mailFrom = '';
      let rcptTo: string[] = [];
      let dataLines: string[] = [];

      socket.write('220 localhost ESMTP LocalSmtpTestServer\r\n');

      const handleCommand = (line: string): void => {
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-localhost\r\n250 8BITMIME\r\n');
          return;
        }
        if (upper.startsWith('MAIL FROM:')) {
          mailFrom = line.slice(10).replace(/[<>]/g, '').trim();
          rcptTo = [];
          socket.write('250 2.1.0 OK\r\n');
          return;
        }
        if (upper.startsWith('RCPT TO:')) {
          const to = line.slice(8).replace(/[<>]/g, '').trim();
          if (this.failRemaining > 0) {
            this.failRemaining -= 1;
            socket.write(`${this.failCodeLine.replace('{to}', to)}\r\n`);
            return;
          }
          rcptTo.push(to);
          socket.write('250 2.1.5 OK\r\n');
          return;
        }
        if (upper === 'DATA') {
          inData = true;
          dataLines = [];
          socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
          return;
        }
        if (upper === 'RSET') {
          mailFrom = '';
          rcptTo = [];
          socket.write('250 2.0.0 OK\r\n');
          return;
        }
        if (upper === 'NOOP') {
          socket.write('250 2.0.0 OK\r\n');
          return;
        }
        if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        }
        socket.write('250 OK\r\n');
      };

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
          const nlIdx = buffer.indexOf('\r\n');
          if (nlIdx < 0) {
            break;
          }
          const line = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              const raw = dataLines.join('\r\n');
              const parsed = parseMimeRawEmail(raw);
              this.messages.push({
                from: mailFrom,
                to: [...rcptTo],
                subject: parsed.subject,
                text: parsed.text,
                html: parsed.html,
                raw,
              });
              socket.write(`250 2.0.0 OK id=${randomUUID()}\r\n`);
            } else {
              dataLines.push(line.startsWith('..') ? line.slice(1) : line);
            }
          } else {
            handleCommand(line);
          }
        }
      });
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  failNext(count: number, codeLine = '421 4.3.2 Temporary SMTP outage'): void {
    this.failRemaining = count;
    this.failCodeLine = codeLine;
  }

  clearMessages(): void {
    this.messages.length = 0;
    this.failRemaining = 0;
  }
}

function extractCookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

function futureUtcDateString(daysAhead: number): string {
  const dt = new Date(Date.now() + daysAhead * 86_400_000);
  return dt.toISOString().slice(0, 10);
}

describe('Transactional email notifications via SMTP adapter (P2-08)', () => {
  let smtpServer: LocalSmtpTestServer;
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let bookingService: BookingService;
  let outboxService: OutboxService;
  let inboxService: InboxService;
  let refundService: RefundService;
  let mockProvider: MockPaymentProvider;
  let notificationsService: NotificationsService;
  let adminCookie: string;
  let idemSeq = 1;
  let userIpSeq = 1;
  let logBuffer = '';

  let prevDbUrl: string | undefined;
  let prevAuthSecret: string | undefined;
  let prevTrustedOrigins: string | undefined;
  let prevTrustedProxy: string | undefined;
  let prevBossDisabled: string | undefined;
  let prevMockSecret: string | undefined;
  let prevMockCallback: string | undefined;
  let prevSmtpHost: string | undefined;
  let prevSmtpPort: string | undefined;
  let prevSmtpSecure: string | undefined;
  let prevMailFrom: string | undefined;
  let prevWebBaseUrl: string | undefined;
  let prevAppEnv: string | undefined;

  function nextIdemKey(): string {
    return `p2-08-key-${idemSeq++}`;
  }

  function nextForwardedIp(): string {
    const idx = userIpSeq++;
    const third = Math.floor(idx / 250);
    const fourth = (idx % 250) + 1;
    return `10.98.${third}.${fourth}`;
  }

  async function drainOutboxAndNotifications(): Promise<void> {
    while ((await outboxService.relayBatch({ batchSize: 100 })) > 0) {
      // keep draining
    }
    await notificationsService.processDueEmails();
  }

  async function drainInbox(): Promise<void> {
    while ((await inboxService.relayBatch({ batchSize: 100 })) > 0) {
      // keep draining
    }
  }

  async function signUpAndSignIn(
    email: string,
    name: string,
    grantAdmin = false,
    emailVerified = false,
  ): Promise<{ cookie: string; userId: string }> {
    const ip = nextForwardedIp();
    const password = 'StrongNotifPass123!';
    const su = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({ email, password, name }),
    });
    expect(su.status).toBe(200);

    if (grantAdmin) {
      await grantRoleByEmail(db, email, 'admin');
    }

    const userRes = await testDb.pool.query<{ id: string }>(
      `SELECT id FROM identity."user" WHERE email = $1`,
      [email],
    );
    const userId = userRes.rows[0]!.id;

    if (emailVerified) {
      await testDb.pool.query(`UPDATE identity."user" SET email_verified = true WHERE id = $1`, [
        userId,
      ]);
    }

    const si = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({ email, password }),
    });
    expect(si.status).toBe(200);
    return { cookie: extractCookieHeader(si), userId };
  }

  async function adminPost<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function adminPut<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function createDemoTour(options: {
    prefix: string;
    slugSuffix: string;
    adultPrice?: string;
    childPrice?: string;
  }): Promise<{ productId: string; departureId: string; viSlug: string }> {
    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: `${options.prefix} Supplier`,
      countryAlpha2: 'VN',
    });
    expect(sup.status).toBe(201);

    const prod = await adminPost<AdminCatalogProductDto>('/admin/products', {
      supplierId: sup.body.id,
      kind: 'tour',
      countryAlpha2: 'VN',
      region: 'Phú Quốc',
      location: { lat: 10.02, lng: 104.01 },
      meetingPointNote: 'Cảng An Thới — Cổng số 2 / An Thoi Pier Gate 2',
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    expect(prod.status).toBe(201);

    const viSlug = `tour-vi-${options.slugSuffix}`;
    await adminPut(`/admin/products/${prod.body.id}/translations/vi`, {
      title: `Tour Phú Quốc ${options.prefix}`,
      slug: viSlug,
      summary: `Tóm tắt ${options.prefix}`,
      description: `Chi tiết ${options.prefix}`,
    });
    await adminPut(`/admin/products/${prod.body.id}/translations/en`, {
      title: `Phu Quoc Tour ${options.prefix}`,
      slug: `tour-en-${options.slugSuffix}`,
      summary: `Summary ${options.prefix}`,
      description: `Details ${options.prefix}`,
    });
    expect((await adminPost(`/admin/products/${prod.body.id}/publish`)).status).toBe(200);

    await adminPost(`/admin/pricing/products/${prod.body.id}/price-lists`, {
      currency: 'VND',
      validFrom: '2026-01-01',
      items: [
        {
          paxType: 'adult',
          amountMinor: options.adultPrice ?? '1000000',
          minAge: 10,
          occupiesSeat: true,
        },
        {
          paxType: 'child',
          amountMinor: options.childPrice ?? '550000',
          minAge: 5,
          maxAge: 9,
          occupiesSeat: true,
        },
        { paxType: 'infant', amountMinor: '0', minAge: 0, maxAge: 4, occupiesSeat: false },
      ],
    });
    await adminPost(`/admin/pricing/products/${prod.body.id}/cancellation-policies`, {
      rules: [
        { hoursBeforeStart: 48, refundPercent: 100 },
        { hoursBeforeStart: 24, refundPercent: 50 },
        { hoursBeforeStart: 0, refundPercent: 0 },
      ],
      weatherClause: 'full_refund_or_reschedule',
    });

    const depDate = futureUtcDateString(20);
    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${prod.body.id}/departures/generate`,
      {
        fromDate: depDate,
        toDate: depDate,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['09:00'],
        capacity: 20,
        bookingCutoffMinutes: 60,
      },
    );
    expect(gen.status).toBe(200);
    return { productId: prod.body.id, departureId: gen.body.createdIds[0]!, viSlug };
  }

  async function fastForwardEmailNextAttempt(emailMessageId: string): Promise<void> {
    const client = await testDb.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE notifications.email_messages DISABLE TRIGGER trg_email_messages_transition',
      );
      await client.query(
        `UPDATE notifications.email_messages SET next_attempt_at = now() WHERE id = $1::uuid`,
        [emailMessageId],
      );
      await client.query(
        'ALTER TABLE notifications.email_messages ENABLE TRIGGER trg_email_messages_transition',
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    smtpServer = new LocalSmtpTestServer();
    const smtpPort = await smtpServer.start();

    prevDbUrl = process.env['DATABASE_URL'];
    prevAuthSecret = process.env['BETTER_AUTH_SECRET'];
    prevTrustedOrigins = process.env['AUTH_TRUSTED_ORIGINS'];
    prevTrustedProxy = process.env['TRUSTED_PROXY_CIDRS'];
    prevBossDisabled = process.env['PG_BOSS_DISABLED'];
    prevMockSecret = process.env['MOCK_PSP_SECRET'];
    prevMockCallback = process.env['MOCK_PSP_CALLBACK_URL'];
    prevSmtpHost = process.env['SMTP_HOST'];
    prevSmtpPort = process.env['SMTP_PORT'];
    prevSmtpSecure = process.env['SMTP_SECURE'];
    prevMailFrom = process.env['MAIL_FROM'];
    prevWebBaseUrl = process.env['PUBLIC_WEB_BASE_URL'];
    prevAppEnv = process.env['APP_ENV'];

    delete process.env['APP_ENV'];
    process.env['NODE_ENV'] = 'test';
    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3000,http://127.0.0.1';
    process.env['TRUSTED_PROXY_CIDRS'] = '127.0.0.1/32,::1/128';
    process.env['PG_BOSS_DISABLED'] = 'true';
    process.env['MOCK_PSP_SECRET'] = TEST_MOCK_PSP_SECRET;
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = String(smtpPort);
    process.env['SMTP_SECURE'] = 'false';
    process.env['MAIL_FROM'] = 'no-reply@demo.internationalota.local';
    process.env['PUBLIC_WEB_BASE_URL'] = 'https://demo-web.internationalota.local';

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;
    await seedReferenceData(testDb.db);

    const logStream = new Writable({
      write(chunk: Buffer | string, _encoding, cb) {
        logBuffer += chunk.toString();
        cb();
      },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const captureLogger = createPinoLogger({ destination: logStream, level: 'info' });
    app = moduleFixture.createNestApplication({
      bodyParser: false,
      bufferLogs: true,
    });
    configureApp(app, { logger: captureLogger });
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
    process.env['MOCK_PSP_CALLBACK_URL'] = `${baseUrl}/webhooks/mock-psp`;

    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
    bookingService = moduleFixture.get(BookingService);
    outboxService = moduleFixture.get(OutboxService);
    inboxService = moduleFixture.get(InboxService);
    refundService = moduleFixture.get(RefundService);
    mockProvider = moduleFixture.get(MockPaymentProvider);
    notificationsService = moduleFixture.get(NotificationsService);

    adminCookie = (await signUpAndSignIn('notif-admin@example.com', 'Notif Admin', true, true))
      .cookie;
  });

  beforeEach(() => {
    smtpServer.clearMessages();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (testDb) {
      await testDb.teardown();
    }
    if (smtpServer) {
      await smtpServer.stop();
    }
    const restoreEnv = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restoreEnv('DATABASE_URL', prevDbUrl);
    restoreEnv('BETTER_AUTH_SECRET', prevAuthSecret);
    restoreEnv('AUTH_TRUSTED_ORIGINS', prevTrustedOrigins);
    restoreEnv('TRUSTED_PROXY_CIDRS', prevTrustedProxy);
    restoreEnv('PG_BOSS_DISABLED', prevBossDisabled);
    restoreEnv('MOCK_PSP_SECRET', prevMockSecret);
    restoreEnv('MOCK_PSP_CALLBACK_URL', prevMockCallback);
    restoreEnv('SMTP_HOST', prevSmtpHost);
    restoreEnv('SMTP_PORT', prevSmtpPort);
    restoreEnv('SMTP_SECURE', prevSmtpSecure);
    restoreEnv('MAIL_FROM', prevMailFrom);
    restoreEnv('PUBLIC_WEB_BASE_URL', prevWebBaseUrl);
    restoreEnv('APP_ENV', prevAppEnv);
  });

  it('AC1: Happy path hold -> pay -> confirm sends localized vi (2.550.000 ₫) & en (₫2,550,000) emails with U1 policy + expired rebook link', async () => {
    const { productId, departureId, viSlug } = await createDemoTour({
      prefix: 'AC1 2-1-1',
      slugSuffix: 'ac1-211',
      adultPrice: '1000000',
      childPrice: '550000',
    });

    // 1. Vietnamese customer (2 adults, 1 child, 1 infant = 2,550,000 VND)
    const viUser = await signUpAndSignIn('ac1-vi-pii@example.com', 'Nguyen Van An', false, true);
    const quoteVi = (await (
      await fetch(
        `${baseUrl}/catalog/products/${productId}/quote?departureId=${departureId}&adult=2&child=1&infant=1&locale=vi`,
      )
    ).json()) as PublicQuoteResponse;
    expect(quoteVi.totalAmountMinor).toBe('2550000');

    const holdVi = (await (
      await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: viUser.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 2, child: 1, infant: 1 },
          contact: {
            name: 'Nguyen Van An',
            email: 'ac1-vi-pii@example.com',
            phone: '+84909111222',
            locale: 'vi',
          },
          expectedSnapshotHash: quoteVi.snapshotHash,
        }),
      })
    ).json()) as HoldBookingResponseDto;

    await drainOutboxAndNotifications();
    expect(smtpServer.messages).toHaveLength(1);
    const heldViMail = smtpServer.messages[0]!;
    expect(heldViMail.to).toEqual(['ac1-vi-pii@example.com']);
    expect(heldViMail.subject).toContain(holdVi.reference);
    expect(heldViMail.text).toContain('2.550.000\u00a0₫'.replace('\u00a0', ' ').slice(0, 7));
    expect(heldViMail.text).toContain('2.550.000');
    expect(heldViMail.text).toContain('Asia/Ho_Chi_Minh');
    expect(heldViMail.text).toContain(
      `https://demo-web.internationalota.local/vi/bookings/${holdVi.reference}`,
    );
    expect(heldViMail.text).toContain('DEMO —');

    // Checkout + pay + confirm -> sends confirmed email with meeting point + U1 wording
    const coVi = (await (
      await fetch(`${baseUrl}/bookings/${holdVi.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: viUser.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;
    await fetch(`${baseUrl}${coVi.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await drainInbox();
    await drainOutboxAndNotifications();

    expect(smtpServer.messages).toHaveLength(2);
    const confirmedViMail = smtpServer.messages[1]!;
    expect(confirmedViMail.to).toEqual(['ac1-vi-pii@example.com']);
    expect(confirmedViMail.subject).toContain(holdVi.reference);
    expect(confirmedViMail.text).toContain('2.550.000');
    expect(confirmedViMail.text).toContain('Cảng An Thới');
    expect(confirmedViMail.text).toContain('Hủy từ 48 giờ trở lên trước giờ khởi hành: hoàn 100%.');
    expect(confirmedViMail.html).toContain('Hủy từ 48 giờ trở lên trước giờ khởi hành: hoàn 100%.');

    // 2. English customer (₫2,550,000 + EN U1 policy)
    smtpServer.clearMessages();
    const enUser = await signUpAndSignIn('ac1-en-pii@example.com', 'Jane English', false, true);
    const holdEn = (await (
      await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: enUser.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 2, child: 1, infant: 1 },
          contact: {
            name: 'Jane English',
            email: 'ac1-en-pii@example.com',
            phone: '+14155550199',
            locale: 'en',
          },
          expectedSnapshotHash: quoteVi.snapshotHash,
        }),
      })
    ).json()) as HoldBookingResponseDto;
    const coEn = (await (
      await fetch(`${baseUrl}/bookings/${holdEn.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: enUser.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;
    await fetch(`${baseUrl}${coEn.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await drainInbox();
    await drainOutboxAndNotifications();

    expect(smtpServer.messages).toHaveLength(2);
    const confirmedEnMail = smtpServer.messages[1]!;
    expect(confirmedEnMail.to).toEqual(['ac1-en-pii@example.com']);
    expect(confirmedEnMail.text).toContain('₫2,550,000');
    expect(confirmedEnMail.text).toContain('Cancel 48+ hours before start: 100% refund.');
    expect(confirmedEnMail.text).toContain('DEMO —');

    // 3. Expired hold -> expired email with tour rebook link
    smtpServer.clearMessages();
    const expRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: viUser.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 2, child: 1, infant: 1 },
        contact: {
          name: 'Expired Tester',
          email: 'ac1-vi-pii@example.com',
          phone: '+84909111222',
          locale: 'vi',
        },
        expectedSnapshotHash: quoteVi.snapshotHash,
      }),
    });
    expect(expRes.status).toBe(201);
    const expHold = (await expRes.json()) as HoldBookingResponseDto;
    await drainOutboxAndNotifications();
    smtpServer.clearMessages();

    const c = await testDb.pool.connect();
    try {
      await c.query('ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition');
      await c.query(
        `UPDATE booking.bookings SET hold_expires_at = now() - interval '2 minutes' WHERE id = $1::uuid`,
        [expHold.id],
      );
      await c.query('ALTER TABLE booking.bookings ENABLE TRIGGER trg_bookings_transition');
    } finally {
      c.release();
    }
    await bookingService.expireDue({ limit: 10 });
    await drainOutboxAndNotifications();

    expect(smtpServer.messages).toHaveLength(1);
    expect(smtpServer.messages[0]!.subject).toContain(expHold.reference);
    expect(smtpServer.messages[0]!.text).toContain(
      `https://demo-web.internationalota.local/vi/tours/${viSlug}`,
    );
  });

  it('AC2 & Mutations (a, b): Exactly once under 3x concurrency, retry success on attempt 3, dead after 5, and ota_app grants', async () => {
    const { productId, departureId } = await createDemoTour({
      prefix: 'AC2 Retry',
      slugSuffix: 'ac2-retry',
    });
    const quote = (await (
      await fetch(
        `${baseUrl}/catalog/products/${productId}/quote?departureId=${departureId}&adult=1&child=0&infant=0&locale=vi`,
      )
    ).json()) as PublicQuoteResponse;
    const u = await signUpAndSignIn('ac2-exact@example.com', 'AC2 Tester', false, true);

    const hold = (await (
      await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: u.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 1, child: 0, infant: 0 },
          contact: {
            name: 'AC2',
            email: 'ac2-exact@example.com',
            phone: '+84901000222',
            locale: 'vi',
          },
          expectedSnapshotHash: quote.snapshotHash,
        }),
      })
    ).json()) as HoldBookingResponseDto;

    // 1. Concurrent 3x delivery of the exact same outbox event -> 1 row and 1 SMTP email (kills Mutations a & b)
    const [heldEvent] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, hold.id));
    expect(heldEvent).toBeDefined();

    await Promise.all([
      notificationsService.handleBookingEvent('booking_held', heldEvent!),
      notificationsService.handleBookingEvent('booking_held', heldEvent!),
      notificationsService.handleBookingEvent('booking_held', heldEvent!),
    ]);
    await notificationsService.processDueEmails();

    const concurrentRows = await db
      .select()
      .from(notificationsEmailMessages)
      .where(eq(notificationsEmailMessages.eventId, heldEvent!.id));
    expect(concurrentRows).toHaveLength(1);
    expect(concurrentRows[0]!.status).toBe('sent');
    expect(smtpServer.messages).toHaveLength(1);

    // Mark outbox event published cleanly so later relays do not re-dispatch
    await testDb.pool.query(
      `UPDATE platform.outbox_events SET published_at = now() WHERE id = $1::uuid`,
      [heldEvent!.id],
    );

    // Trigger guard: cannot transition sent email back to queued
    await expect(
      testDb.pool.query(
        `UPDATE notifications.email_messages SET status = 'queued', sent_at = NULL, version = version + 1 WHERE id = $1::uuid`,
        [concurrentRows[0]!.id],
      ),
    ).rejects.toThrow(/Illegal email message status transition/);

    // 2. Flaky SMTP down for 2 attempts -> succeeds on attempt 3
    smtpServer.clearMessages();
    await drainOutboxAndNotifications();
    smtpServer.clearMessages();

    const holdFlaky = (await (
      await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: u.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 1, child: 0, infant: 0 },
          contact: {
            name: 'AC2 Flaky',
            email: 'ac2-flaky@example.com',
            phone: '+84901000333',
            locale: 'vi',
          },
          expectedSnapshotHash: quote.snapshotHash,
        }),
      })
    ).json()) as HoldBookingResponseDto;

    smtpServer.failNext(2, '421 4.3.2 Outage for <{to}>');
    await drainOutboxAndNotifications();
    expect(smtpServer.messages).toHaveLength(0);

    const [flakyEvt] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, holdFlaky.id));
    let [flakyMsg] = await db
      .select()
      .from(notificationsEmailMessages)
      .where(eq(notificationsEmailMessages.eventId, flakyEvt!.id));
    expect(flakyMsg!.status).toBe('failed');
    expect(flakyMsg!.attempts).toBe(1);
    expect(flakyMsg!.lastError).not.toContain('ac2-flaky@example.com');
    expect(flakyMsg!.lastError).toContain('[REDACTED_EMAIL]');

    await fastForwardEmailNextAttempt(flakyMsg!.id);
    await notificationsService.processDueEmails();
    [flakyMsg] = await db
      .select()
      .from(notificationsEmailMessages)
      .where(eq(notificationsEmailMessages.id, flakyMsg!.id));
    expect(flakyMsg!.status).toBe('failed');
    expect(flakyMsg!.attempts).toBe(2);

    await fastForwardEmailNextAttempt(flakyMsg!.id);
    await notificationsService.processDueEmails();
    [flakyMsg] = await db
      .select()
      .from(notificationsEmailMessages)
      .where(eq(notificationsEmailMessages.id, flakyMsg!.id));
    expect(flakyMsg!.status).toBe('sent');
    expect(smtpServer.messages).toHaveLength(1);

    // 3. Permanently down SMTP -> dead after 5 attempts
    smtpServer.clearMessages();
    const holdDead = (await (
      await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: u.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 1, child: 0, infant: 0 },
          contact: {
            name: 'AC2 Dead',
            email: 'ac2-dead@example.com',
            phone: '+84901000444',
            locale: 'en',
          },
          expectedSnapshotHash: quote.snapshotHash,
        }),
      })
    ).json()) as HoldBookingResponseDto;

    smtpServer.failNext(5, '550 5.1.1 Mailbox <{to}> unavailable');
    await drainOutboxAndNotifications();
    const [deadEvt] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, holdDead.id));
    const [deadRowInit] = await db
      .select()
      .from(notificationsEmailMessages)
      .where(eq(notificationsEmailMessages.eventId, deadEvt!.id));

    for (let tryIdx = 2; tryIdx <= 5; tryIdx++) {
      await fastForwardEmailNextAttempt(deadRowInit!.id);
      await notificationsService.processDueEmails();
    }
    const [deadFinal] = await db
      .select()
      .from(notificationsEmailMessages)
      .where(eq(notificationsEmailMessages.id, deadRowInit!.id));
    expect(deadFinal!.status).toBe('dead');
    expect(deadFinal!.attempts).toBe(5);
    expect(deadFinal!.lastError).not.toContain('ac2-dead@example.com');
    expect(smtpServer.messages).toHaveLength(0);

    // 4. ota_app least-privilege runtime grants on notifications.email_messages
    const roleName = 'ota_app_notifications_test';
    await testDb.pool.query(`DROP OWNED BY ${roleName}`).catch(() => undefined);
    await testDb.pool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await testDb.pool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD 'rolepass'`);
    try {
      await applyRuntimeRoleGrants(testDb.db, roleName);
      const url = new URL(testDb.testUrl);
      url.username = roleName;
      url.password = 'rolepass';
      const rc = createDbClient({ connectionString: url.toString(), max: 1 });
      try {
        await rc.pool.query('SELECT COUNT(*) FROM notifications.email_messages');
        await expect(
          rc.pool.query('DELETE FROM notifications.email_messages WHERE id = $1::uuid', [
            deadFinal!.id,
          ]),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await rc.pool.end();
      }
    } finally {
      await testDb.pool.query(`DROP OWNED BY ${roleName}; DROP ROLE IF EXISTS ${roleName};`);
    }
  });

  it('AC3: Cancellation at 30h sends 50% refund email; settlement webhook sends refund_succeeded email with same amount', async () => {
    await drainOutboxAndNotifications();
    smtpServer.clearMessages();

    const { productId, departureId } = await createDemoTour({
      prefix: 'AC3 Refund',
      slugSuffix: 'ac3-refund',
      adultPrice: '1000000',
    });
    const quote = (await (
      await fetch(
        `${baseUrl}/catalog/products/${productId}/quote?departureId=${departureId}&adult=1&child=0&infant=0&locale=vi`,
      )
    ).json()) as PublicQuoteResponse;
    const u = await signUpAndSignIn('ac3-cancel@example.com', 'AC3 Guest', false, true);

    const hold = (await (
      await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: u.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 1, child: 0, infant: 0 },
          contact: {
            name: 'AC3 Guest',
            email: 'ac3-cancel@example.com',
            phone: '+84905556666',
            locale: 'vi',
          },
          expectedSnapshotHash: quote.snapshotHash,
        }),
      })
    ).json()) as HoldBookingResponseDto;

    const co = (await (
      await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: u.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;
    await fetch(`${baseUrl}${co.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await drainInbox();
    await drainOutboxAndNotifications();
    smtpServer.clearMessages();

    // Shift departure to +30 hours -> 50% refund = 500,000 VND
    await testDb.pool.query(
      `UPDATE inventory.departures SET starts_at = now() + interval '30 hours' WHERE id = $1::uuid`,
      [departureId],
    );
    const cancelRes = await fetch(`${baseUrl}/bookings/${hold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: u.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(cancelRes.status).toBe(200);
    await drainOutboxAndNotifications();

    expect(smtpServer.messages).toHaveLength(1);
    const cancelEmail = smtpServer.messages[0]!;
    expect(cancelEmail.subject).toContain(hold.reference);
    expect(cancelEmail.text).toContain('50%');
    expect(cancelEmail.text).toContain('500.000');

    // Execute & settle refund -> refund_succeeded email
    smtpServer.clearMessages();
    await refundService.processDueRefunds();
    const mrRes = await testDb.pool.query<{ provider_refund_ref: string }>(
      `SELECT provider_refund_ref FROM payments.mock_psp_refunds`,
    );
    for (const mr of mrRes.rows) {
      await mockProvider.deliverPendingRefundCallback(
        mr.provider_refund_ref,
        `${baseUrl}/webhooks/mock-psp`,
      );
    }
    await drainInbox();
    await drainOutboxAndNotifications();

    const refundEmails = smtpServer.messages.filter((m) => m.subject.includes(hold.reference));
    expect(refundEmails).toHaveLength(1);
    expect(refundEmails[0]!.text).toContain('500.000');
    expect(refundEmails[0]!.text).toContain('5');
  });

  it('AC4: Identity verification and password reset emails route cleanly via SMTP with working verification link', async () => {
    smtpServer.clearMessages();
    const email = 'ac4-identity@example.com';
    const ip = nextForwardedIp();
    const suRes = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({ email, password: 'IdentityPass!2026', name: 'AC4 Identity' }),
    });
    expect(suRes.status).toBe(200);

    const verifyTrigger = await fetch(`${baseUrl}/api/auth/send-verification-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({ email }),
    });
    expect(verifyTrigger.status).toBe(200);

    const verifyMail = smtpServer.messages.find((m) => m.to.includes(email));
    expect(verifyMail).toBeDefined();
    const linkMatch = /(https?:\/\/[^\s"'<>]+\/api\/auth\/verify-email[^\s"'<>]+)/.exec(
      verifyMail!.text,
    );
    expect(linkMatch).not.toBeNull();

    const followRes = await fetch(linkMatch![1]!, { redirect: 'manual' });
    expect([200, 302]).toContain(followRes.status);

    const verifiedRow = await testDb.pool.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM identity."user" WHERE email = $1`,
      [email],
    );
    expect(verifiedRow.rows[0]?.email_verified).toBe(true);

    // Password reset request
    smtpServer.clearMessages();
    const resetTrigger = await fetch(`${baseUrl}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({ email }),
    });
    expect(resetTrigger.status).toBe(200);
    const resetMail = smtpServer.messages.find((m) => m.to.includes(email));
    expect(resetMail).toBeDefined();
    expect(resetMail!.text).toMatch(/reset-password/i);
  });

  it('AC5 & Mutation (d): Logs contain zero email addresses, names, or phones, and email_messages only stores SHA-256 hash', async () => {
    expect(logBuffer.length).toBeGreaterThan(0);
    expect(logBuffer).toContain('notification_email_sent');

    const piiTokens = [
      'ac1-vi-pii@example.com',
      'ac1-en-pii@example.com',
      'ac2-flaky@example.com',
      'ac2-dead@example.com',
      'ac3-cancel@example.com',
      'ac4-identity@example.com',
      '+84909111222',
      '+14155550199',
      'Nguyen Van An',
      'Jane English',
    ];
    for (const token of piiTokens) {
      expect(logBuffer).not.toContain(token);
    }

    const dbRows = await testDb.pool.query<{ recipient_hash: string; last_error: string | null }>(
      `SELECT recipient_hash, last_error FROM notifications.email_messages`,
    );
    expect(dbRows.rows.length).toBeGreaterThan(0);
    const expectedHash = createHash('sha256').update('ac1-vi-pii@example.com').digest('hex');
    expect(dbRows.rows.some((r) => r.recipient_hash === expectedHash)).toBe(true);
    for (const r of dbRows.rows) {
      expect(r.recipient_hash).toMatch(/^[0-9a-f]{64}$/);
      if (r.last_error) {
        for (const token of piiTokens) {
          expect(r.last_error).not.toContain(token);
        }
      }
    }
  });

  it('AC6 & Mutation (c): APP_ENV=production fails boot with LogEmailTransport or incomplete SMTP config', async () => {
    const savedNodeEnv = process.env['NODE_ENV'];
    const savedAppEnv = process.env['APP_ENV'];
    const savedPublicBase = process.env['PUBLIC_BASE_URL'];
    const savedSmtpHost = process.env['SMTP_HOST'];
    const savedSmtpPort = process.env['SMTP_PORT'];
    const savedMailFrom = process.env['MAIL_FROM'];

    process.env['NODE_ENV'] = 'production';
    process.env['APP_ENV'] = 'production';
    process.env['PUBLIC_BASE_URL'] = 'https://prod-notif-guard.example.com';

    try {
      // 1. No SMTP_HOST in production -> fails Identity/EmailSender guard on compile
      delete process.env['SMTP_HOST'];
      await expect(
        Test.createTestingModule({
          imports: [AppModule],
        }).compile(),
      ).rejects.toThrow(/production/i);

      // 2. Partial SMTP config (missing MAIL_FROM) in production -> fails cleanly
      process.env['SMTP_HOST'] = 'smtp.example.com';
      process.env['SMTP_PORT'] = '587';
      delete process.env['MAIL_FROM'];
      await expect(
        Test.createTestingModule({
          imports: [AppModule],
        }).compile(),
      ).rejects.toThrow(/incomplete SMTP configuration/i);

      // 3. LogEmailTransport overridden directly into NotificationsService in production -> fails init guard (kills Mutation c)
      process.env['MAIL_FROM'] = 'ops@example.com';
      const dummySender: EmailSender = {
        sendVerificationEmail: async () => {},
        sendResetPasswordEmail: async () => {},
      };
      const prodModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(dummySender)
        .overrideProvider(EMAIL_TRANSPORT)
        .useClass(LogEmailTransport)
        .compile();

      const prodApp = prodModule.createNestApplication({ bodyParser: false });
      try {
        await expect(prodApp.init()).rejects.toThrow(/LogEmailTransport cannot be used/i);
      } finally {
        await prodApp.close().catch(() => undefined);
      }
    } finally {
      process.env['NODE_ENV'] = savedNodeEnv;
      if (savedAppEnv === undefined) delete process.env['APP_ENV'];
      else process.env['APP_ENV'] = savedAppEnv;
      if (savedPublicBase === undefined) delete process.env['PUBLIC_BASE_URL'];
      else process.env['PUBLIC_BASE_URL'] = savedPublicBase;
      if (savedSmtpHost === undefined) delete process.env['SMTP_HOST'];
      else process.env['SMTP_HOST'] = savedSmtpHost;
      if (savedSmtpPort === undefined) delete process.env['SMTP_PORT'];
      else process.env['SMTP_PORT'] = savedSmtpPort;
      if (savedMailFrom === undefined) delete process.env['MAIL_FROM'];
      else process.env['MAIL_FROM'] = savedMailFrom;
    }
  });
});
