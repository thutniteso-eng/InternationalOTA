import { createHmac, randomUUID } from 'node:crypto';
import {
  applyRuntimeRoleGrants,
  createDbClient,
  type DatabaseClient,
  eq,
  grantRoleByEmail,
  inboxMessages,
  paymentsMockPspTransactions,
  paymentsPaymentAttempts,
  seedReferenceData,
} from '@internationalota/db';
import { type INestApplication, Logger } from '@nestjs/common';
import { type ExecutionContext } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  type BookingDetailDto,
  BookingService,
  type HoldBookingResponseDto,
} from '../booking/index.js';
import type { AdminCatalogProductDto } from '../catalog/index.js';
import { LedgerService } from '../finance/index.js';
import { AuthGuard, EMAIL_SENDER } from '../identity/index.js';
import { type GenerateDeparturesResult } from '../inventory/index.js';
import { InboxService } from '../messaging/index.js';
import { type PublicQuoteResponse } from '../pricing/index.js';
import type { SupplierRecord } from '../supply/index.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { PaymentProviderRegistry } from './payment-provider.registry.js';
import { PaymentsService } from './payments.service.js';
import type { InitiateCheckoutResponseDto, PaymentProvider } from './payments.types.js';

const TEST_AUTH_SECRET = 'p2-05-checkout-payments-auth-secret-min-32-chars';
const TEST_MOCK_PSP_SECRET = 'p2-05-mock-psp-hmac-secret-at-least-32-chars';

function createStartBarrier(parties: number) {
  let arrived = 0;
  let releaseAll!: () => void;
  const gate = new Promise<void>((res) => {
    releaseAll = res;
  });
  return async () => {
    arrived++;
    if (arrived === parties) {
      releaseAll();
    }
    await gate;
  };
}

function extractCookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

function futureUtcDateString(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

describe('Checkout saga & Mock PSP adapter (P2-05)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let bookingService: BookingService;
  let ledgerService: LedgerService;
  let inboxService: InboxService;
  let paymentsService: PaymentsService;
  let mockProvider: MockPaymentProvider;
  let providerRegistry: PaymentProviderRegistry;

  let adminCookie: string;
  let customerACookie: string;
  let customerAId: string;
  let customerBCookie: string;

  let expectedClearingTotalMinor = 0n;
  let expectedPrepaymentsTotalMinor = 0n;
  let expectedRefundsPayableTotalMinor = 0n;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousTrustedOrigins: string | undefined;
  let previousTrustedProxyCidrs: string | undefined;
  let previousBossDisabled: string | undefined;
  let previousMockPspSecret: string | undefined;
  let previousMockPspCallbackUrl: string | undefined;
  let previousAppEnv: string | undefined;

  let idemSeq = 0;
  const nextIdemKey = () => `p2-05-key-${++idemSeq}`;

  let userIpSeq = 1;
  function nextForwardedIp(): string {
    const idx = userIpSeq++;
    const third = Math.floor(idx / 250);
    const fourth = (idx % 250) + 1;
    return `10.95.${third}.${fourth}`;
  }

  async function signUpAndSignIn(
    email: string,
    name: string,
    grantAdmin = false,
    emailVerified = false,
  ): Promise<{ cookie: string; userId: string }> {
    const forwardedIp = nextForwardedIp();
    const password = 'StrongPaymentPass123!';
    const signUpRes = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': forwardedIp,
      },
      body: JSON.stringify({ email, password, name }),
    });
    expect(signUpRes.status).toBe(200);

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

    const signInRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': forwardedIp,
      },
      body: JSON.stringify({ email, password }),
    });
    expect(signInRes.status).toBe(200);
    return { cookie: extractCookieHeader(signInRes), userId };
  }

  async function adminPost<T>(
    path: string,
    body?: unknown,
    key = nextIdemKey(),
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': key,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function adminPut<T>(
    path: string,
    body: unknown,
    key = nextIdemKey(),
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function createTourDeparture(options: {
    prefix: string;
    slugSuffix: string;
    capacity: number;
    adultPrice?: string;
  }): Promise<{ productId: string; departureId: string; quote: PublicQuoteResponse }> {
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
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    expect(prod.status).toBe(201);

    await adminPut(`/admin/products/${prod.body.id}/translations/vi`, {
      title: `Tour ${options.prefix}`,
      slug: `tour-${options.slugSuffix}`,
      summary: `Tóm tắt ${options.prefix}`,
      description: `Mô tả ${options.prefix}`,
    });
    await adminPut(`/admin/products/${prod.body.id}/translations/en`, {
      title: `${options.prefix} Tour`,
      slug: `en-tour-${options.slugSuffix}`,
      summary: `Summary ${options.prefix}`,
      description: `Details ${options.prefix}`,
    });
    const pub = await adminPost(`/admin/products/${prod.body.id}/publish`);
    expect(pub.status).toBe(200);

    const priceRes = await adminPost(`/admin/pricing/products/${prod.body.id}/price-lists`, {
      currency: 'VND',
      validFrom: '2026-01-01',
      items: [
        {
          paxType: 'adult',
          amountMinor: options.adultPrice ?? '1250000',
          minAge: 10,
          occupiesSeat: true,
        },
        {
          paxType: 'child',
          amountMinor: '750000',
          minAge: 5,
          maxAge: 9,
          occupiesSeat: true,
        },
        {
          paxType: 'infant',
          amountMinor: '0',
          minAge: 0,
          maxAge: 4,
          occupiesSeat: false,
        },
      ],
    });
    expect(priceRes.status).toBe(201);

    const policyRes = await adminPost(
      `/admin/pricing/products/${prod.body.id}/cancellation-policies`,
      {
        rules: [
          { hoursBeforeStart: 24, refundPercent: 100 },
          { hoursBeforeStart: 0, refundPercent: 0 },
        ],
      },
    );
    expect(policyRes.status).toBe(201);

    const depDate = futureUtcDateString(30);
    const genRes = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${prod.body.id}/departures/generate`,
      {
        fromDate: depDate,
        toDate: depDate,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['09:00'],
        capacity: options.capacity,
        bookingCutoffMinutes: 60,
      },
    );
    expect(genRes.status).toBe(200);
    const departureId = genRes.body.createdIds[0]!;

    const quoteRes = await fetch(
      `${baseUrl}/catalog/products/${prod.body.id}/quote?departureId=${departureId}&adult=1&child=0&infant=0&locale=vi`,
    );
    expect(quoteRes.status).toBe(200);
    const quote = (await quoteRes.json()) as PublicQuoteResponse;

    return { productId: prod.body.id, departureId, quote };
  }

  async function createCustomerHold(
    cookie: string,
    departureId: string,
    quote: PublicQuoteResponse,
    locale = 'vi',
  ): Promise<HoldBookingResponseDto> {
    const res = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Pay Traveler',
          email: 'traveler@example.com',
          phone: '+84901234567',
          locale,
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as HoldBookingResponseDto;
  }

  async function fastForwardHoldExpiry(bookingId: string): Promise<void> {
    const client = await testDb.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition');
      await client.query(
        `UPDATE booking.bookings SET hold_expires_at = now() - interval '2 minutes' WHERE id = $1`,
        [bookingId],
      );
      await client.query('ALTER TABLE booking.bookings ENABLE TRIGGER trg_bookings_transition');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function backdateAttemptCreatedAt(attemptId: string, minutesAgo: number): Promise<void> {
    const client = await testDb.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE payments.payment_attempts DISABLE TRIGGER trg_payment_attempts_transition',
      );
      await client.query(
        `UPDATE payments.payment_attempts
         SET created_at = now() - ($2 * interval '1 minute')
         WHERE id = $1`,
        [attemptId, minutesAgo],
      );
      await client.query(
        'ALTER TABLE payments.payment_attempts ENABLE TRIGGER trg_payment_attempts_transition',
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousTrustedOrigins = process.env['AUTH_TRUSTED_ORIGINS'];
    previousTrustedProxyCidrs = process.env['TRUSTED_PROXY_CIDRS'];
    previousBossDisabled = process.env['PG_BOSS_DISABLED'];
    previousMockPspSecret = process.env['MOCK_PSP_SECRET'];
    previousMockPspCallbackUrl = process.env['MOCK_PSP_CALLBACK_URL'];
    previousAppEnv = process.env['APP_ENV'];

    delete process.env['APP_ENV'];
    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3000,http://127.0.0.1';
    process.env['TRUSTED_PROXY_CIDRS'] = '127.0.0.1/32,::1/128';
    process.env['PG_BOSS_DISABLED'] = 'true';
    process.env['MOCK_PSP_SECRET'] = TEST_MOCK_PSP_SECRET;

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;
    await seedReferenceData(testDb.db);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
    process.env['MOCK_PSP_CALLBACK_URL'] = `${baseUrl}/webhooks/mock-psp`;

    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
    bookingService = moduleFixture.get(BookingService);
    ledgerService = moduleFixture.get(LedgerService);
    inboxService = moduleFixture.get(InboxService);
    paymentsService = moduleFixture.get(PaymentsService);
    mockProvider = moduleFixture.get(MockPaymentProvider);
    providerRegistry = moduleFixture.get(PaymentProviderRegistry);

    const admin = await signUpAndSignIn('pay-admin@example.com', 'Pay Admin', true, true);
    adminCookie = admin.cookie;
    const custA = await signUpAndSignIn('pay-a@example.com', 'Pay Customer A', false, true);
    customerACookie = custA.cookie;
    customerAId = custA.userId;
    const custB = await signUpAndSignIn('pay-b@example.com', 'Pay Customer B', false, true);
    customerBCookie = custB.cookie;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    const restoreEnv = (key: string, prev: string | undefined) => {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    };
    restoreEnv('DATABASE_URL', previousDatabaseUrl);
    restoreEnv('BETTER_AUTH_SECRET', previousAuthSecret);
    restoreEnv('AUTH_TRUSTED_ORIGINS', previousTrustedOrigins);
    restoreEnv('TRUSTED_PROXY_CIDRS', previousTrustedProxyCidrs);
    restoreEnv('PG_BOSS_DISABLED', previousBossDisabled);
    restoreEnv('MOCK_PSP_SECRET', previousMockPspSecret);
    restoreEnv('MOCK_PSP_CALLBACK_URL', previousMockPspCallbackUrl);
    restoreEnv('APP_ENV', previousAppEnv);

    if (testDb) {
      await testDb.teardown();
    }
  });

  it('AC1 & Mutation (c): Happy path via Mock PSP HTML, atomic ledger posting, outbox, and transactional rollback check', async () => {
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC1 Happy',
      slugSuffix: 'ac1-happy',
      capacity: 10,
      adultPrice: '1500000',
    });

    const hold = await createCustomerHold(customerACookie, departureId, quote, 'en');

    // Checkout initiates payment & returns Mock PSP redirectUrl
    const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerACookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({ returnUrl: `/en/bookings/${hold.reference}` }),
    });
    expect(checkoutRes.status).toBe(200);
    const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;
    expect(checkout.provider).toBe('mock');
    expect(checkout.providerRef).toMatch(/^mock_/);
    expect(checkout.redirectUrl).toBe(`/mock-psp/checkout/${checkout.providerRef}`);

    // Verify GET /bookings/:reference shows initiated attempt
    const detailBeforeRes = await fetch(`${baseUrl}/bookings/${hold.reference}`, {
      headers: { Cookie: customerACookie },
    });
    expect(detailBeforeRes.status).toBe(200);
    const detailBefore = (await detailBeforeRes.json()) as BookingDetailDto;
    expect(detailBefore.status).toBe('payment_pending');
    expect(detailBefore.payment).toEqual({ status: 'initiated', attemptCount: 1 });

    // Render hosted Mock PSP page & inspect formatted money + booking reference + dev buttons
    const pageRes = await fetch(`${baseUrl}${checkout.redirectUrl}`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain(hold.reference);
    expect(html).toContain('value="success"');
    expect(html).toContain('value="duplicate"');
    expect(html).toContain('value="delayed_3m"');
    expect(html).toContain('value="wrong_amount"');

    // Mutation (c) atomic rollback proof: disable liability account temporarily, deliver webhook, relay fails and leaves ZERO partial commit
    // First ensure the account exists via an inactive pre-created account row or after an initial posting check:
    // Create prepayments account inactive first? Not yet created, so pre-create inactive to test rollback:
    await testDb.pool.query(
      `INSERT INTO finance.accounts (id, code, name, type, currency, is_active)
       VALUES ($1, 'liability:customer_prepayments:VND', 'Customer Prepayments (VND)', 'liability', 'VND', false)
       ON CONFLICT (code) DO UPDATE SET is_active = false`,
      [randomUUID()],
    );

    // Submit "Pay successfully" on hosted form (disable redirect auto-follow)
    const actionRes = await fetch(`${baseUrl}${checkout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    expect(actionRes.status).toBe(303);
    expect(actionRes.headers.get('location')).toBe(`/en/bookings/${hold.reference}`);

    // Relay while account is inactive -> LedgerService throws, entire savepoint rolls back (booking remains payment_pending, attempt remains initiated)
    await inboxService.relayBatch();
    const afterRollbackBooking = await bookingService.getBookingForCustomerByReference(
      hold.reference,
      customerAId,
    );
    expect(afterRollbackBooking.status).toBe('payment_pending');
    expect(afterRollbackBooking.paymentRef).toBeNull();
    const afterRollbackAttempt = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, checkout.attemptId));
    expect(afterRollbackAttempt[0]?.status).toBe('initiated');
    const clearingDuringRollback = await ledgerService.getAccountByCode(
      'asset:psp_clearing:mock:VND',
    );
    if (clearingDuringRollback) {
      const bal = await ledgerService.balance(clearingDuringRollback.id);
      expect(bal.amountMinor).toBe(expectedClearingTotalMinor);
    }

    // Re-activate account & reset inbox retry timer -> relay confirms booking + posts ledger atomically
    await testDb.pool.query(
      `UPDATE finance.accounts SET is_active = true WHERE code = 'liability:customer_prepayments:VND'`,
    );
    await testDb.pool.query(`UPDATE platform.inbox_messages SET next_attempt_at = now()`);

    expect(await inboxService.relayBatch()).toBe(1);

    const confirmedDetailRes = await fetch(`${baseUrl}/bookings/${hold.reference}`, {
      headers: { Cookie: customerACookie },
    });
    expect(confirmedDetailRes.status).toBe(200);
    const confirmedDetail = (await confirmedDetailRes.json()) as BookingDetailDto;
    expect(confirmedDetail.status).toBe('confirmed');
    expect(confirmedDetail.paymentRef).toBe(checkout.providerRef);
    expect(confirmedDetail.payment).toEqual({ status: 'succeeded', attemptCount: 1 });
    expect(
      confirmedDetail.events?.some(
        (e) =>
          e.fromStatus === 'payment_pending' &&
          e.toStatus === 'confirmed' &&
          e.actor === 'system:payment',
      ),
    ).toBe(true);

    const attemptRows = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, checkout.attemptId));
    expect(attemptRows[0]?.status).toBe('succeeded');
    expect(attemptRows[0]?.completedAt).not.toBeNull();
    expect(attemptRows[0]?.providerConfigSnapshot).toEqual({
      provider: 'mock',
      mode: 'simulator',
      version: 1,
    });

    expectedClearingTotalMinor += 1_500_000n;
    expectedPrepaymentsTotalMinor += 1_500_000n;

    const outboxRes = await testDb.pool.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events
       WHERE aggregate_id IN ($1::text, $2::text)`,
      [hold.id, checkout.attemptId],
    );
    const eventTypes = outboxRes.rows.map((r) => r.event_type);
    expect(eventTypes).toContain('booking.confirmed');
    expect(eventTypes).toContain('payment.succeeded');
    expect(eventTypes).toContain('payment.initiated');
  });

  it('AC2 & Mutation (b): Duplicate signed callbacks (5x concurrent + unsigned header variants) and distinct second event are no-op', async () => {
    await testDb.pool.query('DELETE FROM platform.inbox_messages');

    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC2 Dup',
      slugSuffix: 'ac2-dup',
      capacity: 10,
      adultPrice: '2000000',
    });
    const hold = await createCustomerHold(customerACookie, departureId, quote);

    const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;

    const eventId1 = randomUUID();
    const signed1 = mockProvider.buildSignedCallback({
      eventId: eventId1,
      providerRef: checkout.providerRef,
      outcome: 'succeeded',
      amountMinor: 2_000_000n,
      currency: 'VND',
      occurredAt: new Date().toISOString(),
    });

    // Deliver exact same signed callback 5x concurrently with differing unsigned headers (kills Mutation b)
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        fetch(`${baseUrl}/webhooks/mock-psp`, {
          method: 'POST',
          headers: {
            ...signed1.headers,
            'x-mock-event-id': `fake-unsigned-${i}`,
          },
          body: signed1.rawBody,
        }),
      ),
    );
    for (const r of responses) {
      expect(r.status).toBe(200);
    }

    const inboxRows = await db.select().from(inboxMessages);
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]?.providerEventId).toBe(eventId1);

    expect(await inboxService.relayBatch()).toBe(1);
    expectedClearingTotalMinor += 2_000_000n;
    expectedPrepaymentsTotalMinor += 2_000_000n;

    // Now deliver a SECOND distinct eventId for the already-succeeded attempt -> info log, no-op, no 2nd ledger entry
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    try {
      const eventId2 = randomUUID();
      const signed2 = mockProvider.buildSignedCallback({
        eventId: eventId2,
        providerRef: checkout.providerRef,
        outcome: 'succeeded',
        amountMinor: 2_000_000n,
        currency: 'VND',
        occurredAt: new Date().toISOString(),
      });
      const res2 = await fetch(`${baseUrl}/webhooks/mock-psp`, {
        method: 'POST',
        headers: signed2.headers,
        body: signed2.rawBody,
      });
      expect(res2.status).toBe(200);
      expect(await inboxService.relayBatch()).toBe(1);

      const joinedLogs = logSpy.mock.calls.flat().map(String).join('\n');
      expect(joinedLogs).toContain('payment_callback_already_terminal');

      const ledgerEntriesCount = await testDb.pool.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM finance.journal_entries WHERE source_id = $1`,
        [checkout.attemptId],
      );
      expect(ledgerEntriesCount.rows[0]?.cnt).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('AC3: Late success after hold expiry sets attempt refund_required, posts refunds_payable, and leaves seats released', async () => {
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC3 Late',
      slugSuffix: 'ac3-late',
      capacity: 5,
      adultPrice: '900000',
    });
    const hold = await createCustomerHold(customerACookie, departureId, quote);

    const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;

    await fastForwardHoldExpiry(hold.id);
    const exp = await bookingService.expireDue({ limit: 10 });
    expect(exp.expiredCount).toBe(1);

    const actionRes = await fetch(`${baseUrl}${checkout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    expect(actionRes.status).toBe(303);
    await inboxService.relayBatch();

    const detail = await bookingService.getBookingForCustomerByReference(
      hold.reference,
      customerAId,
    );
    expect(detail.status).toBe('expired');

    const [attempt] = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, checkout.attemptId));
    expect(attempt?.status).toBe('refund_required');

    expectedClearingTotalMinor += 900_000n;
    expectedRefundsPayableTotalMinor += 900_000n;

    const depRes = await testDb.pool.query<{ allocated: number }>(
      `SELECT allocated FROM inventory.departures WHERE id = $1`,
      [departureId],
    );
    expect(depRes.rows[0]?.allocated).toBe(0);
    const verifyAlloc = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(verifyAlloc.rows).toHaveLength(0);
  });

  it('AC4: Callback vs expireDue race at expiry instant across 20 runs always picks exactly one consistent outcome', async () => {
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC4 Race',
      slugSuffix: 'ac4-race',
      capacity: 30,
      adultPrice: '500000',
    });

    for (let i = 0; i < 20; i++) {
      const racer = await signUpAndSignIn(
        `ac4-racer-${i}@example.com`,
        `AC4 Racer ${i}`,
        false,
        true,
      );
      const hold = await createCustomerHold(racer.cookie, departureId, quote);
      const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: racer.cookie, 'Idempotency-Key': nextIdemKey() },
      });
      const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;

      await fastForwardHoldExpiry(hold.id);

      const signed = mockProvider.buildSignedCallback({
        eventId: randomUUID(),
        providerRef: checkout.providerRef,
        outcome: 'succeeded',
        amountMinor: 500_000n,
        currency: 'VND',
        occurredAt: new Date().toISOString(),
      });
      const hookRes = await fetch(`${baseUrl}/webhooks/mock-psp`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.rawBody,
      });
      expect(hookRes.status).toBe(200);

      const barrier = createStartBarrier(2);
      await Promise.all([
        (async () => {
          await barrier();
          return inboxService.relayBatch();
        })(),
        (async () => {
          await barrier();
          return bookingService.expireDue({ limit: 5 });
        })(),
      ]);

      // Drain any unclaimed inbox item if relay raced empty
      await inboxService.relayBatch();

      const [attempt] = await db
        .select()
        .from(paymentsPaymentAttempts)
        .where(eq(paymentsPaymentAttempts.id, checkout.attemptId));
      const detail = await bookingService.getBookingForCustomerByReference(
        hold.reference,
        racer.userId,
      );

      if (detail.status === 'confirmed') {
        expect(attempt?.status).toBe('succeeded');
        expectedClearingTotalMinor += 500_000n;
        expectedPrepaymentsTotalMinor += 500_000n;
      } else {
        expect(detail.status).toBe('expired');
        expect(attempt?.status).toBe('refund_required');
        expectedClearingTotalMinor += 500_000n;
        expectedRefundsPayableTotalMinor += 500_000n;
      }
    }

    const mismatch = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(mismatch.rows).toHaveLength(0);
  }, 90_000);

  it('AC5 & Mutation (a): Amount mismatch fails attempt, leaves booking payment_pending, writes zero ledger, enqueues outbox', async () => {
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC5 Mismatch',
      slugSuffix: 'ac5-mismatch',
      capacity: 5,
      adultPrice: '1100000',
    });
    const hold = await createCustomerHold(customerACookie, departureId, quote);
    const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;

    // Trigger dev-panel wrong_amount action
    const actionRes = await fetch(`${baseUrl}${checkout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=wrong_amount',
    });
    expect(actionRes.status).toBe(303);
    await inboxService.relayBatch();

    const detail = await bookingService.getBookingForCustomerByReference(
      hold.reference,
      customerAId,
    );
    expect(detail.status).toBe('payment_pending');
    expect(detail.paymentRef).toBeNull();

    const [attempt] = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, checkout.attemptId));
    expect(attempt?.status).toBe('failed');
    expect(attempt?.failureReason).toBe('amount_mismatch');

    const ledgerRes = await testDb.pool.query(
      `SELECT 1 FROM finance.journal_entries WHERE source_id = $1`,
      [checkout.attemptId],
    );
    expect(ledgerRes.rows).toHaveLength(0);

    const outboxRes = await testDb.pool.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events WHERE aggregate_id = $1`,
      [checkout.attemptId],
    );
    expect(outboxRes.rows.map((r) => r.event_type)).toContain('payment.amount_mismatch');
  });

  it('R1 & M7: Currency mismatch with matching minor amount fails attempt, leaves booking payment_pending, writes zero ledger, enqueues outbox', async () => {
    const r1User = await signUpAndSignIn('r1-currency@example.com', 'R1 Currency', false, true);
    const { departureId, quote } = await createTourDeparture({
      prefix: 'R1 Currency',
      slugSuffix: 'r1-currency',
      capacity: 5,
      adultPrice: '1100000',
    });
    const hold = await createCustomerHold(r1User.cookie, departureId, quote);
    const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: r1User.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;

    // Exact same minor amount (1100000) in wrong currency ('USD' instead of 'VND')
    const signedWrongCurrency = mockProvider.buildSignedCallback({
      eventId: randomUUID(),
      providerRef: checkout.providerRef,
      outcome: 'succeeded',
      amountMinor: 1_100_000n,
      currency: 'USD',
      occurredAt: new Date().toISOString(),
    });
    const webhookRes = await fetch(`${baseUrl}/webhooks/mock-psp`, {
      method: 'POST',
      headers: signedWrongCurrency.headers,
      body: signedWrongCurrency.rawBody,
    });
    expect(webhookRes.status).toBe(200);
    await inboxService.relayBatch();

    const detail = await bookingService.getBookingForCustomerByReference(
      hold.reference,
      r1User.userId,
    );
    expect(detail.status).toBe('payment_pending');
    expect(detail.paymentRef).toBeNull();

    const [attempt] = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, checkout.attemptId));
    expect(attempt?.status).toBe('failed');
    expect(attempt?.failureReason).toBe('amount_mismatch');

    const ledgerRes = await testDb.pool.query(
      `SELECT 1 FROM finance.journal_entries WHERE source_id = $1`,
      [checkout.attemptId],
    );
    expect(ledgerRes.rows).toHaveLength(0);

    const outboxRes = await testDb.pool.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events WHERE aggregate_id = $1`,
      [checkout.attemptId],
    );
    expect(outboxRes.rows.map((r) => r.event_type)).toContain('payment.amount_mismatch');
  });

  it('AC6 & Mutation (e): Rejects bad signatures, missing headers, timestamp skew > 5m, >1MB body, and disables Mock PSP in production', async () => {
    const inboxCountBefore = (await db.select().from(inboxMessages)).length;

    const payload = JSON.stringify({
      eventId: randomUUID(),
      providerRef: 'mock_fake_security',
      outcome: 'succeeded',
      amountMinor: '100',
      currency: 'VND',
      occurredAt: new Date().toISOString(),
    });
    const nowTs = Math.floor(Date.now() / 1000).toString();

    // 1. Bad signature -> 401
    const badSigRes = await fetch(`${baseUrl}/webhooks/mock-psp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mock-signature': '0'.repeat(64),
        'x-mock-timestamp': nowTs,
      },
      body: payload,
    });
    expect(badSigRes.status).toBe(401);

    // 2. Missing headers -> 401
    const missingHdrRes = await fetch(`${baseUrl}/webhooks/mock-psp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    expect(missingHdrRes.status).toBe(401);

    // 3. Timestamp skew > 5 min -> 401
    const staleTs = (Math.floor(Date.now() / 1000) - 301).toString();
    const staleSig = createHmac('sha256', TEST_MOCK_PSP_SECRET)
      .update(`${staleTs}.${payload}`)
      .digest('hex');
    const skewRes = await fetch(`${baseUrl}/webhooks/mock-psp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mock-signature': staleSig,
        'x-mock-timestamp': staleTs,
      },
      body: payload,
    });
    expect(skewRes.status).toBe(401);

    // 4. Body > 1 MB -> 413
    const hugeBody = JSON.stringify({
      eventId: randomUUID(),
      providerRef: 'mock_huge',
      outcome: 'succeeded',
      amountMinor: '100',
      currency: 'VND',
      occurredAt: new Date().toISOString(),
      pad: 'x'.repeat(1_100_000),
    });
    const hugeSig = createHmac('sha256', TEST_MOCK_PSP_SECRET)
      .update(`${nowTs}.${hugeBody}`)
      .digest('hex');
    const hugeRes = await fetch(`${baseUrl}/webhooks/mock-psp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mock-signature': hugeSig,
        'x-mock-timestamp': nowTs,
      },
      body: hugeBody,
    });
    expect(hugeRes.status).toBe(413);

    const inboxCountAfter = (await db.select().from(inboxMessages)).length;
    expect(inboxCountAfter).toBe(inboxCountBefore);

    // 5. APP_ENV=production disables Mock adapter (404 on /mock-psp/* and /webhooks/mock-psp, 503 no_provider on checkout)
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC6 Prod',
      slugSuffix: 'ac6-prod',
      capacity: 5,
    });
    const prodHold = await createCustomerHold(customerACookie, departureId, quote);

    const savedAppEnv = process.env['APP_ENV'];
    const savedPublicBaseUrl = process.env['PUBLIC_BASE_URL'];
    process.env['APP_ENV'] = 'production';
    process.env['PUBLIC_BASE_URL'] = 'https://prod.example.com';
    let prodApp: INestApplication | undefined;
    try {
      const prodModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue({
          sendVerificationEmail: () => Promise.resolve(),
          sendResetPasswordEmail: () => Promise.resolve(),
        })
        .overrideGuard(AuthGuard)
        .useValue({
          canActivate: (ctx: ExecutionContext) => {
            const req = ctx.switchToHttp().getRequest<{ principal?: unknown }>();
            req.principal = {
              userId: customerAId,
              email: 'pay-a@example.com',
              name: 'Pay Customer A',
              roles: ['customer'],
              kind: 'customer',
              emailVerified: true,
            };
            return true;
          },
        })
        .compile();
      prodApp = prodModule.createNestApplication({ bodyParser: false });
      configureApp(prodApp);
      await prodApp.init();
      await prodApp.listen(0);
      const prodUrl = await prodApp.getUrl();

      const mockPageRes = await fetch(`${prodUrl}/mock-psp/checkout/mock_any`);
      expect(mockPageRes.status).toBe(404);

      const mockWebhookRes = await fetch(`${prodUrl}/webhooks/mock-psp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mock-signature': createHmac('sha256', TEST_MOCK_PSP_SECRET)
            .update(`${nowTs}.${payload}`)
            .digest('hex'),
          'x-mock-timestamp': nowTs,
        },
        body: payload,
      });
      expect(mockWebhookRes.status).toBe(404);

      const prodCheckoutRes = await fetch(`${prodUrl}/bookings/${prodHold.reference}/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: customerACookie,
          'Idempotency-Key': nextIdemKey(),
        },
      });
      expect(prodCheckoutRes.status).toBe(503);
      const errBody = (await prodCheckoutRes.json()) as { code?: string };
      expect(errBody.code).toBe('no_provider');
    } finally {
      if (prodApp) {
        await prodApp.close();
      }
      if (savedAppEnv === undefined) {
        delete process.env['APP_ENV'];
      } else {
        process.env['APP_ENV'] = savedAppEnv;
      }
      if (savedPublicBaseUrl === undefined) {
        delete process.env['PUBLIC_BASE_URL'];
      } else {
        process.env['PUBLIC_BASE_URL'] = savedPublicBaseUrl;
      }
    }
  });

  it('AC7: Reconciliation recovers lost callbacks after 20m, expires pending attempts after 60m, and handles cancel/delayed actions', async () => {
    const ac7User = await signUpAndSignIn('ac7-user@example.com', 'AC7 User', false, true);
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC7 Recon',
      slugSuffix: 'ac7-recon',
      capacity: 10,
      adultPrice: '1300000',
    });

    // 1. Lost callback recovery + cancel button leaves status untouched
    const lostHold = await createCustomerHold(ac7User.cookie, departureId, quote);
    const lostCheckoutRes = await fetch(`${baseUrl}/bookings/${lostHold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: ac7User.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    const lostCheckout = (await lostCheckoutRes.json()) as InitiateCheckoutResponseDto;

    // Cancel action writes zero inbox/mock state and redirects cleanly
    const cancelActionRes = await fetch(`${baseUrl}${lostCheckout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=cancel',
    });
    expect(cancelActionRes.status).toBe(303);

    // Simulate success recorded in mock PSP DB without webhook delivery
    await db
      .update(paymentsMockPspTransactions)
      .set({ status: 'succeeded', lastEventId: randomUUID(), occurredAt: new Date() })
      .where(eq(paymentsMockPspTransactions.providerRef, lostCheckout.providerRef));

    await backdateAttemptCreatedAt(lostCheckout.attemptId, 25);

    const reconRes = await paymentsService.reconcilePending();
    expect(reconRes.resolvedCount).toBeGreaterThanOrEqual(1);

    const lostBooking = await bookingService.getBookingForCustomerByReference(
      lostHold.reference,
      ac7User.userId,
    );
    expect(lostBooking.status).toBe('confirmed');
    expect(lostBooking.paymentRef).toBe(lostCheckout.providerRef);
    expectedClearingTotalMinor += 1_300_000n;
    expectedPrepaymentsTotalMinor += 1_300_000n;

    // 2. Stale pending > 60 min -> expired
    const staleHold = await createCustomerHold(ac7User.cookie, departureId, quote);
    const staleCheckoutRes = await fetch(`${baseUrl}/bookings/${staleHold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: ac7User.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    const staleCheckout = (await staleCheckoutRes.json()) as InitiateCheckoutResponseDto;
    await backdateAttemptCreatedAt(staleCheckout.attemptId, 65);

    const expireRes = await paymentsService.reconcilePending();
    expect(expireRes.expiredCount).toBeGreaterThanOrEqual(1);
    const [expiredAttempt] = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, staleCheckout.attemptId));
    expect(expiredAttempt?.status).toBe('expired');

    // 3. Delayed 3m callback action records mock transaction succeeded and delayed delivery worker confirms booking
    const delayedHold = await createCustomerHold(ac7User.cookie, departureId, quote);
    const delayedCheckoutRes = await fetch(
      `${baseUrl}/bookings/${delayedHold.reference}/checkout`,
      {
        method: 'POST',
        headers: { Cookie: ac7User.cookie, 'Idempotency-Key': nextIdemKey() },
      },
    );
    const delayedCheckout = (await delayedCheckoutRes.json()) as InitiateCheckoutResponseDto;
    const delayedActionRes = await fetch(`${baseUrl}${delayedCheckout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=delayed_3m',
    });
    expect(delayedActionRes.status).toBe(303);
    await mockProvider.deliverDelayedCallback({
      providerRef: delayedCheckout.providerRef,
      callbackUrl: `${baseUrl}/webhooks/mock-psp`,
    });
    await inboxService.relayBatch();
    const delayedBooking = await bookingService.getBookingForCustomerByReference(
      delayedHold.reference,
      ac7User.userId,
    );
    expect(delayedBooking.status).toBe('confirmed');
    expectedClearingTotalMinor += 1_300_000n;
    expectedPrepaymentsTotalMinor += 1_300_000n;
  });

  it('AC8 & AC9: Provider error -> 502 retryable up to 3 attempts, 4th -> 409; D-018/ownership/expired hold enforced', async () => {
    const ac8User = await signUpAndSignIn('ac8-user@example.com', 'AC8 User', false, true);
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC8-9',
      slugSuffix: 'ac8-9',
      capacity: 10,
      adultPrice: '700000',
    });

    // AC9: Unverified customer -> 403 email_not_verified; wrong customer -> 404; expired hold -> 409
    const unverified = await signUpAndSignIn(
      'ac9-unverified@example.com',
      'Unverified Pay',
      false,
      false,
    );
    const unverifiedHold = await createCustomerHold(unverified.cookie, departureId, quote);
    const unverifiedCheckout = await fetch(
      `${baseUrl}/bookings/${unverifiedHold.reference}/checkout`,
      {
        method: 'POST',
        headers: { Cookie: unverified.cookie, 'Idempotency-Key': nextIdemKey() },
      },
    );
    expect(unverifiedCheckout.status).toBe(403);
    expect(((await unverifiedCheckout.json()) as { code?: string }).code).toBe(
      'email_not_verified',
    );

    const verifiedHold = await createCustomerHold(ac8User.cookie, departureId, quote);
    const wrongOwnerRes = await fetch(`${baseUrl}/bookings/${verifiedHold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: customerBCookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(wrongOwnerRes.status).toBe(404);

    // Invalid external returnUrl -> 400
    const badReturnRes = await fetch(`${baseUrl}/bookings/${verifiedHold.reference}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ac8User.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({ returnUrl: 'https://evil.example/steal' }),
    });
    expect(badReturnRes.status).toBe(400);

    // Expired hold (un-swept) -> 409
    const expiredHold = await createCustomerHold(ac8User.cookie, departureId, quote);
    await fastForwardHoldExpiry(expiredHold.id);
    const expiredCheckoutRes = await fetch(
      `${baseUrl}/bookings/${expiredHold.reference}/checkout`,
      {
        method: 'POST',
        headers: { Cookie: ac8User.cookie, 'Idempotency-Key': nextIdemKey() },
      },
    );
    expect(expiredCheckoutRes.status).toBe(409);

    // AC8: Provider down on attempt #1 -> 502 with i18nKey, retry creates attempt #2, #3, 4th -> 409
    const failingMock: PaymentProvider = {
      provider: 'mock',
      webhookSlug: 'mock-psp',
      getConfigSnapshot: () => ({ provider: 'mock', mode: 'failing', version: 1 }),
      createCheckout: () => Promise.reject(new Error('Simulated PSP outage')),
      refund: (input) => mockProvider.refund(input),
      verify: (rawBody, headers) => mockProvider.verify(rawBody, headers),
      verifyWebhook: (rawBody, headers) => mockProvider.verifyWebhook(rawBody, headers),
      getStatus: (ref) => mockProvider.getStatus(ref),
    };

    providerRegistry.register(failingMock);
    try {
      const attempt1Res = await fetch(`${baseUrl}/bookings/${verifiedHold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: ac8User.cookie, 'Idempotency-Key': nextIdemKey() },
      });
      expect(attempt1Res.status).toBe(502);
      const err502 = (await attempt1Res.json()) as { i18nKey?: string; code?: string };
      expect(err502.i18nKey).toBe('payments.checkout.providerUnavailable');
      expect(err502.code).toBe('provider_unavailable');
    } finally {
      providerRegistry.register(mockProvider);
    }

    // Attempt #2 succeeds (plus fail callback keeps booking payment_pending), Attempt #3 succeeds, Attempt #4 -> 409
    const att2Res = await fetch(`${baseUrl}/bookings/${verifiedHold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: ac8User.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(att2Res.status).toBe(200);
    const att2 = (await att2Res.json()) as InitiateCheckoutResponseDto;

    // Customer hits "Fail payment" on hosted page -> attempt #2 failed, booking stays payment_pending
    await fetch(`${baseUrl}${att2.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=fail',
    });
    await inboxService.relayBatch();
    const afterFail = await bookingService.getBookingForCustomerByReference(
      verifiedHold.reference,
      ac8User.userId,
    );
    expect(afterFail.status).toBe('payment_pending');

    const att3Res = await fetch(`${baseUrl}/bookings/${verifiedHold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: ac8User.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(att3Res.status).toBe(200);

    const att4Res = await fetch(`${baseUrl}/bookings/${verifiedHold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: ac8User.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(att4Res.status).toBe(409);
    expect(((await att4Res.json()) as { code?: string }).code).toBe('too_many_attempts');
  });

  it('AC10 & Mutations (d, f): Double payment puts 2nd attempt in refund_required; partial index & trigger block raw SQL tampering + ota_app grants', async () => {
    const ac10User = await signUpAndSignIn('ac10-user@example.com', 'AC10 User', false, true);
    const { departureId, quote } = await createTourDeparture({
      prefix: 'AC10 Double',
      slugSuffix: 'ac10-double',
      capacity: 10,
      adultPrice: '850000',
    });
    const hold = await createCustomerHold(ac10User.cookie, departureId, quote);

    const c1 = (await (
      await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: ac10User.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;

    const c2 = (await (
      await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: ac10User.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;

    await fetch(`${baseUrl}${c1.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await inboxService.relayBatch();
    expectedClearingTotalMinor += 850_000n;
    expectedPrepaymentsTotalMinor += 850_000n;

    await fetch(`${baseUrl}${c2.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await inboxService.relayBatch();
    expectedClearingTotalMinor += 850_000n;
    expectedRefundsPayableTotalMinor += 850_000n;

    const [a1] = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, c1.attemptId));
    const [a2] = await db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, c2.attemptId));
    expect(a1?.status).toBe('succeeded');
    expect(a2?.status).toBe('refund_required');
    expect(a2?.failureReason).toBe('double_payment');

    // Mutation (d): DB trigger blocks terminal transition succeeded -> failed and blocks core immutability
    await expect(
      testDb.pool.query(
        `UPDATE payments.payment_attempts
         SET status = 'failed', failure_reason = 'tamper', version = version + 1
         WHERE id = $1`,
        [c1.attemptId],
      ),
    ).rejects.toThrow(/Illegal payment attempt status transition/);

    // Mutation (f): DB partial unique index blocks two 'succeeded' attempts for one booking
    await expect(
      testDb.pool.query(
        `INSERT INTO payments.payment_attempts
          (id, booking_id, provider, provider_ref, amount_minor, currency, provider_config_snapshot, status, version, completed_at)
         VALUES ($1, $2, 'mock', 'mock_dup_idx', 850000, 'VND', '{}'::jsonb, 'succeeded', 1, now())`,
        [randomUUID(), hold.id],
      ),
    ).rejects.toThrow(/payment_attempts_one_succeeded_per_booking_idx|duplicate key/i);

    // Least-privilege grants for ota_app on payments schema
    const testRole = 'ota_app_payments_test';
    await testDb.pool.query(`DROP OWNED BY ${testRole}`).catch(() => undefined);
    await testDb.pool.query(`DROP ROLE IF EXISTS ${testRole}`);
    await testDb.pool.query(`CREATE ROLE ${testRole} LOGIN PASSWORD 'rolepass'`);
    try {
      await applyRuntimeRoleGrants(testDb.db, testRole);
      const url = new URL(testDb.testUrl);
      url.username = testRole;
      url.password = 'rolepass';
      const runtimeClient = createDbClient({ connectionString: url.toString(), max: 1 });
      try {
        await runtimeClient.pool.query('SELECT COUNT(*) FROM payments.payment_attempts');
        await runtimeClient.pool.query('SELECT COUNT(*) FROM payments.mock_psp_transactions');
        await expect(
          runtimeClient.pool.query('DELETE FROM payments.payment_attempts WHERE id = $1', [
            c1.attemptId,
          ]),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await runtimeClient.pool.end();
      }
    } finally {
      await testDb.pool.query(`DROP OWNED BY ${testRole}; DROP ROLE IF EXISTS ${testRole};`);
    }
  });

  it('AC11: Every journal entry balances per currency and all payment ledger account balances match expected totals', async () => {
    const unbalanced = await testDb.pool.query(
      `SELECT entry_id, currency, SUM(debit_minor) - SUM(credit_minor) AS diff
       FROM finance.journal_lines
       GROUP BY entry_id, currency
       HAVING SUM(debit_minor) <> SUM(credit_minor)`,
    );
    expect(unbalanced.rows).toHaveLength(0);

    const clearingAcc = await ledgerService.getAccountByCode('asset:psp_clearing:mock:VND');
    const prepaymentsAcc = await ledgerService.getAccountByCode(
      'liability:customer_prepayments:VND',
    );
    const refundsAcc = await ledgerService.getAccountByCode('liability:refunds_payable:VND');

    expect(clearingAcc).not.toBeNull();
    expect(prepaymentsAcc).not.toBeNull();
    expect(refundsAcc).not.toBeNull();

    const clearingBal = await ledgerService.balance(clearingAcc!.id);
    const prepaymentsBal = await ledgerService.balance(prepaymentsAcc!.id);
    const refundsBal = await ledgerService.balance(refundsAcc!.id);

    expect(clearingBal.amountMinor).toBe(expectedClearingTotalMinor);
    expect(prepaymentsBal.amountMinor).toBe(expectedPrepaymentsTotalMinor);
    expect(refundsBal.amountMinor).toBe(expectedRefundsPayableTotalMinor);
    expect(clearingBal.amountMinor).toBe(prepaymentsBal.amountMinor + refundsBal.amountMinor);
  });
});
