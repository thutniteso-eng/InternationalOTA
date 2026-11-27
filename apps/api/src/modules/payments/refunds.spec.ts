import { randomUUID } from 'node:crypto';
import {
  applyRuntimeRoleGrants,
  createDbClient,
  type DatabaseClient,
  eq,
  grantRoleByEmail,
  paymentsMockPspRefunds,
  paymentsRefunds,
  seedReferenceData,
} from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  type BookingDetailDto,
  BookingService,
  type ConfirmedCancelResponseDto,
  type HoldBookingResponseDto,
} from '../booking/index.js';
import type { AdminCatalogProductDto } from '../catalog/index.js';
import { LedgerService } from '../finance/index.js';
import { type GenerateDeparturesResult } from '../inventory/index.js';
import { InboxService, OutboxService } from '../messaging/index.js';
import { type PublicQuoteResponse } from '../pricing/index.js';
import type { SupplierRecord } from '../supply/index.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import type {
  AdminRefundDto,
  DepartureCancellationSummaryDto,
  DepartureCancelResultDto,
  InitiateCheckoutResponseDto,
} from './payments.types.js';
import { RefundService } from './refund.service.js';

const TEST_AUTH_SECRET = 'p2-07-cancel-refund-auth-secret-at-least-32-chars';
const TEST_MOCK_PSP_SECRET = 'p2-07-mock-psp-hmac-secret-at-least-32-chars';

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

describe('Cancellation after confirmation & refund execution (P2-07)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let bookingService: BookingService;
  let ledgerService: LedgerService;
  let inboxService: InboxService;
  let outboxService: OutboxService;
  let mockProvider: MockPaymentProvider;
  let refundService: RefundService;

  let adminCookie: string;
  let customerACookie: string;
  let customerAId: string;
  let customerBCookie: string;

  let expectedClearingMinor = 0n;
  let expectedPrepaymentsMinor = 0n;
  let expectedRefundsPayableMinor = 0n;
  let expectedRetainedMinor = 0n;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousTrustedOrigins: string | undefined;
  let previousTrustedProxyCidrs: string | undefined;
  let previousBossDisabled: string | undefined;
  let previousMockPspSecret: string | undefined;
  let previousMockPspCallbackUrl: string | undefined;
  let previousAppEnv: string | undefined;

  let idemSeq = 0;
  const nextIdemKey = () => `p2-07-key-${++idemSeq}`;

  let userIpSeq = 1;
  function nextForwardedIp(): string {
    const idx = userIpSeq++;
    const third = Math.floor(idx / 250);
    const fourth = (idx % 250) + 1;
    return `10.97.${third}.${fourth}`;
  }

  async function signUpAndSignIn(
    email: string,
    name: string,
    grantAdmin = false,
    emailVerified = false,
  ): Promise<{ cookie: string; userId: string }> {
    const forwardedIp = nextForwardedIp();
    const password = 'StrongRefundPass123!';
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

  async function createTourWithPolicyAndDeparture(options: {
    prefix: string;
    slugSuffix: string;
    capacity: number;
    adultPrice?: string;
    rules?: { hoursBeforeStart: number; refundPercent: number }[];
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
          amountMinor: options.adultPrice ?? '1000001',
          minAge: 10,
          occupiesSeat: true,
        },
        {
          paxType: 'child',
          amountMinor: '500000',
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
        rules: options.rules ?? [
          { hoursBeforeStart: 48, refundPercent: 100 },
          { hoursBeforeStart: 24, refundPercent: 50 },
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

  async function setDepartureOffsetFromNow(
    departureId: string,
    hoursOffset: number,
  ): Promise<void> {
    await testDb.pool.query(
      `UPDATE inventory.departures
       SET starts_at = now() + ($2 * interval '1 hour'), updated_at = now()
       WHERE id = $1::uuid`,
      [departureId, hoursOffset],
    );
  }

  async function createAndConfirmBooking(
    cookie: string,
    departureId: string,
    quote: PublicQuoteResponse,
  ): Promise<{ hold: HoldBookingResponseDto; checkout: InitiateCheckoutResponseDto }> {
    const holdRes = await fetch(`${baseUrl}/bookings`, {
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
          name: 'Refund Tester',
          email: 'refund@example.com',
          phone: '+84901234567',
          locale: 'vi',
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(holdRes.status).toBe(201);
    const hold = (await holdRes.json()) as HoldBookingResponseDto;

    const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(checkoutRes.status).toBe(200);
    const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;

    const payAction = await fetch(`${baseUrl}${checkout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    expect(payAction.status).toBe(303);
    await drainInbox();

    const paidAmt = BigInt(hold.totalAmountMinor);
    expectedClearingMinor += paidAmt;
    expectedPrepaymentsMinor += paidAmt;

    return { hold, checkout };
  }

  async function drainInbox(): Promise<void> {
    while ((await inboxService.relayBatch({ batchSize: 100 })) > 0) {}
  }

  async function drainOutbox(): Promise<void> {
    while ((await outboxService.relayBatch({ batchSize: 100 })) > 0) {}
  }

  async function settleAllPendingMockRefunds(): Promise<void> {
    const mockRefunds = await db
      .select()
      .from(paymentsMockPspRefunds)
      .where(eq(paymentsMockPspRefunds.status, 'succeeded'));
    for (const mr of mockRefunds) {
      await mockProvider.deliverPendingRefundCallback(
        mr.providerRefundRef,
        `${baseUrl}/webhooks/mock-psp`,
      );
    }
    await drainInbox();
  }

  async function fastForwardRefundNextAttempt(refundId: string): Promise<void> {
    const client = await testDb.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE payments.refunds DISABLE TRIGGER trg_refunds_transition');
      await client.query(
        `UPDATE payments.refunds SET next_attempt_at = now() WHERE id = $1::uuid`,
        [refundId],
      );
      await client.query('ALTER TABLE payments.refunds ENABLE TRIGGER trg_refunds_transition');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function fastForwardHoldExpiry(bookingId: string): Promise<void> {
    const client = await testDb.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition');
      await client.query(
        `UPDATE booking.bookings SET hold_expires_at = now() - interval '2 minutes' WHERE id = $1::uuid`,
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
    outboxService = moduleFixture.get(OutboxService);
    mockProvider = moduleFixture.get(MockPaymentProvider);
    refundService = moduleFixture.get(RefundService);

    const admin = await signUpAndSignIn('ref-admin@example.com', 'Refund Admin', true, true);
    adminCookie = admin.cookie;
    const custA = await signUpAndSignIn('ref-a@example.com', 'Refund Customer A', false, true);
    customerACookie = custA.cookie;
    customerAId = custA.userId;
    const custB = await signUpAndSignIn('ref-b@example.com', 'Refund Customer B', false, true);
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

  it('AC1 & Mutations (a, e): Refund policy bands (72h=100%, 30h=50% floor, 2h=0%, after start=409) using DB clock', async () => {
    // 1. 72h before -> R = 1,000,001, K = 0, AND prove app-clock drift (Date.now +100h) is ignored (kills Mutation e)
    const { departureId: dep72, quote: q72 } = await createTourWithPolicyAndDeparture({
      prefix: 'AC1-72h',
      slugSuffix: 'ac1-72h',
      capacity: 10,
      adultPrice: '1000001',
    });
    const b72 = await createAndConfirmBooking(customerACookie, dep72, q72);
    await setDepartureOffsetFromNow(dep72, 72);

    const realNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 100 * 3_600_000);
    try {
      const preview72 = await fetch(
        `${baseUrl}/bookings/${b72.hold.reference}/cancellation-preview`,
        {
          headers: { Cookie: customerACookie },
        },
      );
      expect(preview72.status).toBe(200);
      expect(await preview72.json()).toEqual({
        status: 'confirmed',
        currency: 'VND',
        totalAmountMinor: '1000001',
        refundAmountMinor: '1000001',
        refundPercent: 100,
        ruleApplied: { hoursBeforeStart: 48, refundPercent: 100 },
        cancellable: true,
      });

      const crossPreview = await fetch(
        `${baseUrl}/bookings/${b72.hold.reference}/cancellation-preview`,
        { headers: { Cookie: customerBCookie } },
      );
      expect(crossPreview.status).toBe(404);

      const res72 = await fetch(`${baseUrl}/bookings/${b72.hold.reference}/cancel`, {
        method: 'POST',
        headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
      });
      expect(res72.status).toBe(200);
      const dto72 = (await res72.json()) as ConfirmedCancelResponseDto;
      expect(dto72.status).toBe('cancelled');
      expect(dto72.refundAmountMinor).toBe('1000001');
      expect(dto72.refundPercent).toBe(100);
      expect(dto72.refund).toEqual({ amountMinor: '1000001', status: 'requested' });
    } finally {
      dateNowSpy.mockRestore();
    }
    expectedPrepaymentsMinor -= 1_000_001n;
    expectedRefundsPayableMinor += 1_000_001n;

    // 2. 30h before -> 50% of 1,000,001 = 500,000 (RoundingMode.DOWN, kills Mutation a), K = 500,001
    const { departureId: dep30, quote: q30 } = await createTourWithPolicyAndDeparture({
      prefix: 'AC1-30h',
      slugSuffix: 'ac1-30h',
      capacity: 10,
      adultPrice: '1000001',
    });
    const b30 = await createAndConfirmBooking(customerACookie, dep30, q30);
    await setDepartureOffsetFromNow(dep30, 30);

    const preview30 = await fetch(
      `${baseUrl}/bookings/${b30.hold.reference}/cancellation-preview`,
      {
        headers: { Cookie: customerACookie },
      },
    );
    expect(preview30.status).toBe(200);
    expect(await preview30.json()).toEqual({
      status: 'confirmed',
      currency: 'VND',
      totalAmountMinor: '1000001',
      refundAmountMinor: '500000',
      refundPercent: 50,
      ruleApplied: { hoursBeforeStart: 24, refundPercent: 50 },
      cancellable: true,
    });

    const res30 = await fetch(`${baseUrl}/bookings/${b30.hold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(res30.status).toBe(200);
    const dto30 = (await res30.json()) as ConfirmedCancelResponseDto;
    expect(dto30.refundAmountMinor).toBe('500000');
    expect(dto30.refundPercent).toBe(50);
    expect(dto30.refund).toEqual({ amountMinor: '500000', status: 'requested' });

    expectedPrepaymentsMinor -= 1_000_001n;
    expectedRefundsPayableMinor += 500_000n;
    expectedRetainedMinor += 500_001n;

    // 3. 2h before -> R = 0 (no refund row), K = 1,000,001
    const { departureId: dep2, quote: q2 } = await createTourWithPolicyAndDeparture({
      prefix: 'AC1-2h',
      slugSuffix: 'ac1-2h',
      capacity: 10,
      adultPrice: '1000001',
    });
    const b2 = await createAndConfirmBooking(customerACookie, dep2, q2);
    await setDepartureOffsetFromNow(dep2, 2);

    const res2 = await fetch(`${baseUrl}/bookings/${b2.hold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(res2.status).toBe(200);
    const dto2 = (await res2.json()) as ConfirmedCancelResponseDto;
    expect(dto2.refundAmountMinor).toBe('0');
    expect(dto2.refundPercent).toBe(0);
    expect(dto2.refund).toBeUndefined();

    const refundRowsForB2 = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, b2.hold.id));
    expect(refundRowsForB2).toHaveLength(0);

    expectedPrepaymentsMinor -= 1_000_001n;
    expectedRetainedMinor += 1_000_001n;

    // 4. After departure start -> 409 too_late_to_cancel, booking remains confirmed
    const { departureId: depPast, quote: qPast } = await createTourWithPolicyAndDeparture({
      prefix: 'AC1-Past',
      slugSuffix: 'ac1-past',
      capacity: 10,
      adultPrice: '1000001',
    });
    const bPast = await createAndConfirmBooking(customerACookie, depPast, qPast);
    await setDepartureOffsetFromNow(depPast, -1);

    const previewPast = await fetch(
      `${baseUrl}/bookings/${bPast.hold.reference}/cancellation-preview`,
      { headers: { Cookie: customerACookie } },
    );
    expect(previewPast.status).toBe(200);
    expect(await previewPast.json()).toEqual({
      status: 'confirmed',
      currency: 'VND',
      totalAmountMinor: '1000001',
      refundAmountMinor: '0',
      refundPercent: 0,
      ruleApplied: null,
      cancellable: false,
      reason: 'too_late_to_cancel',
    });

    // Held (not paid) booking preview -> not_paid
    const { departureId: depHold, quote: qHold } = await createTourWithPolicyAndDeparture({
      prefix: 'AC1-HoldPreview',
      slugSuffix: 'ac1-hold-preview',
      capacity: 10,
      adultPrice: '1000001',
    });
    const holdPreviewRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerACookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId: depHold,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Hold Preview',
          email: 'hold-preview@example.com',
          phone: '+84901234567',
          locale: 'vi',
        },
        expectedSnapshotHash: qHold.snapshotHash,
      }),
    });
    expect(holdPreviewRes.status).toBe(201);
    const holdPreviewBooking = (await holdPreviewRes.json()) as HoldBookingResponseDto;
    const previewHeld = await fetch(
      `${baseUrl}/bookings/${holdPreviewBooking.reference}/cancellation-preview`,
      { headers: { Cookie: customerACookie } },
    );
    expect(previewHeld.status).toBe(200);
    expect(await previewHeld.json()).toEqual({
      status: 'held',
      currency: 'VND',
      totalAmountMinor: holdPreviewBooking.totalAmountMinor,
      refundAmountMinor: '0',
      cancellable: true,
      reason: 'not_paid',
    });

    const resPast = await fetch(`${baseUrl}/bookings/${bPast.hold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(resPast.status).toBe(409);
    expect(((await resPast.json()) as { code?: string }).code).toBe('too_late_to_cancel');

    const bPastDetail = await bookingService.getBookingForCustomerByReference(
      bPast.hold.reference,
      customerAId,
    );
    expect(bPastDetail.status).toBe('confirmed');
  });

  it('AC2: End-to-end pay -> cancel at 72h -> executor -> mock callback settles refund, releases seats, zeroes balances', async () => {
    const user = await signUpAndSignIn('ac2-e2e@example.com', 'AC2 E2E', false, true);
    const { departureId, quote } = await createTourWithPolicyAndDeparture({
      prefix: 'AC2 E2E',
      slugSuffix: 'ac2-e2e',
      capacity: 5,
      adultPrice: '1000001',
    });
    const b = await createAndConfirmBooking(user.cookie, departureId, quote);
    await setDepartureOffsetFromNow(departureId, 72);

    const cancelRes = await fetch(`${baseUrl}/bookings/${b.hold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: user.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(cancelRes.status).toBe(200);
    expectedPrepaymentsMinor -= 1_000_001n;
    expectedRefundsPayableMinor += 1_000_001n;

    // Execute due refunds (picks requested refunds from AC1 & AC2)
    const execRes = await refundService.processDueRefunds();
    expect(execRes.processedCount).toBeGreaterThanOrEqual(1);

    // Deliver all mock callbacks for succeeded mock refunds
    const mockRefunds = await db.select().from(paymentsMockPspRefunds);
    for (const mr of mockRefunds) {
      await mockProvider.deliverPendingRefundCallback(
        mr.providerRefundRef,
        `${baseUrl}/webhooks/mock-psp`,
      );
    }
    await drainInbox();

    // Update expected settlement for the 2 refunds from AC1 (1,000,001 + 500,000) + AC2 (1,000,001)
    expectedRefundsPayableMinor -= 2_500_002n;
    expectedClearingMinor -= 2_500_002n;

    const detailRes = await fetch(`${baseUrl}/bookings/${b.hold.reference}`, {
      headers: { Cookie: user.cookie },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as BookingDetailDto;
    expect(detail.status).toBe('cancelled');
    expect(detail.refund).toEqual({ amountMinor: '1000001', status: 'succeeded' });
    expect(
      detail.events?.some(
        (e) =>
          e.fromStatus === 'confirmed' &&
          e.toStatus === 'cancelled' &&
          e.actor === `customer:${user.userId}`,
      ),
    ).toBe(true);

    const depRes = await testDb.pool.query<{ allocated: number }>(
      `SELECT allocated FROM inventory.departures WHERE id = $1::uuid`,
      [departureId],
    );
    expect(depRes.rows[0]?.allocated).toBe(0);
    const verifyAlloc = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(verifyAlloc.rows).toHaveLength(0);
  });

  it('AC3: Concurrency — 2 concurrent customer cancels + 20 runs of customer vs departure cancel race yield 1 cancellation & 1 refund', async () => {
    const concUser = await signUpAndSignIn('ac3-conc@example.com', 'AC3 Conc', false, true);
    const { departureId: depDouble, quote: qDouble } = await createTourWithPolicyAndDeparture({
      prefix: 'AC3 Conc',
      slugSuffix: 'ac3-conc',
      capacity: 10,
      adultPrice: '900000',
    });
    const concBooking = await createAndConfirmBooking(concUser.cookie, depDouble, qDouble);
    await setDepartureOffsetFromNow(depDouble, 72);

    const barrier1 = createStartBarrier(2);
    const [c1, c2] = await Promise.all([
      (async () => {
        await barrier1();
        return fetch(`${baseUrl}/bookings/${concBooking.hold.reference}/cancel`, {
          method: 'POST',
          headers: { Cookie: concUser.cookie, 'Idempotency-Key': nextIdemKey() },
        });
      })(),
      (async () => {
        await barrier1();
        return fetch(`${baseUrl}/bookings/${concBooking.hold.reference}/cancel`, {
          method: 'POST',
          headers: { Cookie: concUser.cookie, 'Idempotency-Key': nextIdemKey() },
        });
      })(),
    ]);
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);

    const concRefunds = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, concBooking.hold.id));
    expect(concRefunds).toHaveLength(1);
    const concLedger = await testDb.pool.query(
      `SELECT id FROM finance.journal_entries WHERE source_type = 'booking_cancellation' AND source_id = $1`,
      [concBooking.hold.id],
    );
    expect(concLedger.rows).toHaveLength(1);
    expectedPrepaymentsMinor -= 900_000n;
    expectedRefundsPayableMinor += 900_000n;

    // 20-run race: customer cancel vs operator departure cancel job
    const { departureId: depRace, quote: qRace } = await createTourWithPolicyAndDeparture({
      prefix: 'AC3 Race20',
      slugSuffix: 'ac3-race20',
      capacity: 25,
      adultPrice: '600000',
    });

    const raceBookings: Array<{
      bookingId: string;
      reference: string;
      userId: string;
    }> = [];
    for (let i = 0; i < 20; i++) {
      const racer = await signUpAndSignIn(`ac3-r-${i}@example.com`, `AC3 R${i}`, false, true);
      const b = await createAndConfirmBooking(racer.cookie, depRace, qRace);
      raceBookings.push({
        bookingId: b.hold.id,
        reference: b.hold.reference,
        userId: racer.userId,
      });
    }
    await setDepartureOffsetFromNow(depRace, 72);

    for (const rb of raceBookings) {
      const barrier = createStartBarrier(2);
      await Promise.all([
        (async () => {
          await barrier();
          return refundService.cancelConfirmedBooking(rb.reference, rb.userId);
        })(),
        (async () => {
          await barrier();
          return refundService.executeDepartureBookingCancel({
            bookingId: rb.bookingId,
            departureId: depRace,
            adminUserId: 'op-admin',
            reason: 'weather',
          });
        })(),
      ]);

      const refunds = await db
        .select()
        .from(paymentsRefunds)
        .where(eq(paymentsRefunds.bookingId, rb.bookingId));
      expect(refunds).toHaveLength(1);
      expect(['customer_cancellation', 'departure_cancelled']).toContain(refunds[0]!.reason);

      const detail = await bookingService.getBookingForCustomerByReference(rb.reference, rb.userId);
      expect(detail.status).toBe('cancelled');

      expectedPrepaymentsMinor -= 600_000n;
      expectedRefundsPayableMinor += 600_000n;
    }

    const mismatch = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(mismatch.rows).toHaveLength(0);

    // Settle refunds created in AC3 cleanly so balances stay tracked
    await refundService.processDueRefunds();
    await settleAllPendingMockRefunds();
    expectedRefundsPayableMinor -= 900_000n + 20n * 600_000n;
    expectedClearingMinor -= 900_000n + 20n * 600_000n;
  }, 90_000);

  it('AC4 & Mutations (b, c): Cancel-tx atomicity (rollback preserves seats), over-refund guard, refund state trigger immutability, concurrent executor, and ota_app grants', async () => {
    const user = await signUpAndSignIn('ac4-guard@example.com', 'AC4 Guard', false, true);
    const { departureId, quote } = await createTourWithPolicyAndDeparture({
      prefix: 'AC4 Guard',
      slugSuffix: 'ac4-guard',
      capacity: 5,
      adultPrice: '800000',
    });
    const b = await createAndConfirmBooking(user.cookie, departureId, quote);
    await setDepartureOffsetFromNow(departureId, 72);

    // Atomicity check (kills Mutation c): if cancel transaction rolls back during ledger posting, seats MUST remain allocated
    await testDb.pool.query(
      `UPDATE finance.accounts SET is_active = false WHERE code = 'liability:customer_prepayments:VND'`,
    );
    try {
      const failedCancel = await fetch(`${baseUrl}/bookings/${b.hold.reference}/cancel`, {
        method: 'POST',
        headers: { Cookie: user.cookie, 'Idempotency-Key': nextIdemKey() },
      });
      expect(failedCancel.status).toBeGreaterThanOrEqual(400);

      const depAfterFail = await testDb.pool.query<{ allocated: number }>(
        `SELECT allocated FROM inventory.departures WHERE id = $1::uuid`,
        [departureId],
      );
      expect(depAfterFail.rows[0]?.allocated).toBe(1);
    } finally {
      await testDb.pool.query(
        `UPDATE finance.accounts SET is_active = true WHERE code = 'liability:customer_prepayments:VND'`,
      );
    }

    const cancelRes = await fetch(`${baseUrl}/bookings/${b.hold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: user.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(cancelRes.status).toBe(200);
    expectedPrepaymentsMinor -= 800_000n;
    expectedRefundsPayableMinor += 800_000n;

    const [refundRow] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, b.hold.id));
    expect(refundRow).toBeDefined();

    // Over-refund guard (kills Mutation b): raw SQL inserting a second non-failed refund exceeding attempt amount fails
    await expect(
      testDb.pool.query(
        `INSERT INTO payments.refunds
          (id, booking_id, payment_attempt_id, provider, amount_minor, currency, reason, status, version)
         VALUES ($1, $2, $3, 'mock', 1, 'VND', 'customer_cancellation', 'requested', 1)`,
        [randomUUID(), b.hold.id, refundRow!.paymentAttemptId],
      ),
    ).rejects.toThrow(/exceed payment attempt amount/i);

    // Concurrent executor + settle -> single succeeded execution
    await Promise.all([refundService.processDueRefunds(), refundService.processDueRefunds()]);
    await settleAllPendingMockRefunds();
    expectedRefundsPayableMinor -= 800_000n;
    expectedClearingMinor -= 800_000n;

    // Refund transition trigger immutability: succeeded cannot transition back or alter amount
    await expect(
      testDb.pool.query(
        `UPDATE payments.refunds SET status = 'failed', version = version + 1 WHERE id = $1`,
        [refundRow!.id],
      ),
    ).rejects.toThrow(/Illegal refund status transition/);

    // Least-privilege runtime role grants include payments.refunds and mock_psp_refunds
    const testRole = 'ota_app_refunds_test';
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
        await runtimeClient.pool.query('SELECT COUNT(*) FROM payments.refunds');
        await runtimeClient.pool.query('SELECT COUNT(*) FROM payments.mock_psp_refunds');
        await expect(
          runtimeClient.pool.query('DELETE FROM payments.refunds WHERE id = $1', [refundRow!.id]),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await runtimeClient.pool.end();
      }
    } finally {
      await testDb.pool.query(`DROP OWNED BY ${testRole}; DROP ROLE IF EXISTS ${testRole};`);
    }
  });

  it('AC5 & Mutation (d): Failed 3x -> manual_review + outbox; admin retry -> succeeds; duplicate refund callbacks -> single ledger entry', async () => {
    const user = await signUpAndSignIn('ac5-fail@example.com', 'AC5 Fail', false, true);
    const { departureId, quote } = await createTourWithPolicyAndDeparture({
      prefix: 'AC5 Fail',
      slugSuffix: 'ac5-fail',
      capacity: 5,
      adultPrice: '750000',
    });
    const b = await createAndConfirmBooking(user.cookie, departureId, quote);
    await setDepartureOffsetFromNow(departureId, 72);

    // Switch this mock transaction to auto_fail via hosted dev panel!
    const modeRes = await fetch(`${baseUrl}${b.checkout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=refund_auto_fail',
    });
    expect(modeRes.status).toBe(303);

    await fetch(`${baseUrl}/bookings/${b.hold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: user.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expectedPrepaymentsMinor -= 750_000n;
    expectedRefundsPayableMinor += 750_000n;

    const [refundRow] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, b.hold.id));
    const refundId = refundRow!.id;

    // Run 3 failing tries
    await refundService.processDueRefunds();
    await fastForwardRefundNextAttempt(refundId);
    await refundService.processDueRefunds();
    await fastForwardRefundNextAttempt(refundId);
    const try3 = await refundService.processDueRefunds();
    expect(try3.manualReviewCount).toBe(1);

    const [inManual] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.id, refundId));
    expect(inManual?.status).toBe('manual_review');

    const manualOutbox = await testDb.pool.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events WHERE aggregate_id = $1`,
      [refundId],
    );
    expect(manualOutbox.rows.map((r) => r.event_type)).toContain('refund.manual_review');

    // Switch back to auto_succeed and trigger admin retry (@Idempotent)
    await fetch(`${baseUrl}${b.checkout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=refund_auto_succeed',
    });

    const retryKey = nextIdemKey();
    const retryRes1 = await adminPost<AdminRefundDto>(
      `/admin/refunds/${refundId}/retry`,
      undefined,
      retryKey,
    );
    expect(retryRes1.status).toBe(200);
    expect(retryRes1.body.status).toBe('requested');

    const retryRes2 = await adminPost<AdminRefundDto>(
      `/admin/refunds/${refundId}/retry`,
      undefined,
      retryKey,
    );
    expect(retryRes2.status).toBe(200);
    expect(retryRes2.body.status).toBe('requested');

    await refundService.processDueRefunds();

    const [mockRefRow] = await db
      .select()
      .from(paymentsMockPspRefunds)
      .where(eq(paymentsMockPspRefunds.refundId, refundId));
    expect(mockRefRow).toBeDefined();

    // Deliver the exact same signed refund callback twice AND a distinct 2nd event -> single ledger posting
    const sameEventId = randomUUID();
    const signedSame = mockProvider.buildSignedRefundCallback({
      eventId: sameEventId,
      providerRefundRef: mockRefRow!.providerRefundRef,
      refundId,
      outcome: 'succeeded',
      amountMinor: 750_000n,
      currency: 'VND',
      occurredAt: new Date().toISOString(),
    });
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${baseUrl}/webhooks/mock-psp`, {
        method: 'POST',
        headers: signedSame.headers,
        body: signedSame.rawBody,
      });
      expect(r.status).toBe(200);
    }
    const distinctSigned = mockProvider.buildSignedRefundCallback({
      eventId: randomUUID(),
      providerRefundRef: mockRefRow!.providerRefundRef,
      refundId,
      outcome: 'succeeded',
      amountMinor: 750_000n,
      currency: 'VND',
      occurredAt: new Date().toISOString(),
    });
    await fetch(`${baseUrl}/webhooks/mock-psp`, {
      method: 'POST',
      headers: distinctSigned.headers,
      body: distinctSigned.rawBody,
    });
    await drainInbox();

    expectedRefundsPayableMinor -= 750_000n;
    expectedClearingMinor -= 750_000n;

    const settledEntries = await testDb.pool.query(
      `SELECT id FROM finance.journal_entries WHERE source_type = 'refund' AND source_id = $1`,
      [refundId],
    );
    expect(settledEntries.rows).toHaveLength(1);
  });

  it('AC6: Departure cancel (5 confirmed + 2 held + 1 payment_pending) refunds confirmed 100%, cancels holds, idempotent replay', async () => {
    const { departureId, quote } = await createTourWithPolicyAndDeparture({
      prefix: 'AC6 DepCancel',
      slugSuffix: 'ac6-dep-cancel',
      capacity: 15,
      adultPrice: '500000',
    });

    // Create 5 confirmed bookings
    for (let i = 0; i < 5; i++) {
      const u = await signUpAndSignIn(`ac6-conf-${i}@example.com`, `AC6 Conf ${i}`, false, true);
      await createAndConfirmBooking(u.cookie, departureId, quote);
    }

    // Create 2 held bookings
    for (let i = 0; i < 2; i++) {
      const u = await signUpAndSignIn(`ac6-held-${i}@example.com`, `AC6 Held ${i}`, false, true);
      const r = await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: u.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 1, child: 0, infant: 0 },
          contact: { name: 'Held', email: 'held@example.com', phone: '+84901234567', locale: 'vi' },
          expectedSnapshotHash: quote.snapshotHash,
        }),
      });
      expect(r.status).toBe(201);
    }

    // Create 1 payment_pending booking
    const ppUser = await signUpAndSignIn('ac6-pp@example.com', 'AC6 PP', false, true);
    const ppHoldRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ppUser.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: { name: 'PP', email: 'pp@example.com', phone: '+84901234567', locale: 'vi' },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    const ppHold = (await ppHoldRes.json()) as HoldBookingResponseDto;
    await fetch(`${baseUrl}/bookings/${ppHold.reference}/checkout`, {
      method: 'POST',
      headers: { Cookie: ppUser.cookie, 'Idempotency-Key': nextIdemKey() },
    });

    const cancelKey = nextIdemKey();
    const depCancelRes1 = await adminPost<DepartureCancelResultDto>(
      `/admin/departures/${departureId}/cancel`,
      { reason: 'Severe weather warning' },
      cancelKey,
    );
    expect(depCancelRes1.status).toBe(200);
    expect(depCancelRes1.body.departureStatus).toBe('cancelled');
    expect(depCancelRes1.body.activeHoldsCancelledCount).toBe(3);
    expect(depCancelRes1.body.confirmedJobsEnqueuedCount).toBe(5);

    // Replay same Idempotency-Key -> same result, no duplicates
    const depCancelRes2 = await adminPost<DepartureCancelResultDto>(
      `/admin/departures/${departureId}/cancel`,
      { reason: 'Severe weather warning' },
      cancelKey,
    );
    expect(depCancelRes2.status).toBe(200);
    expect(depCancelRes2.body).toEqual(depCancelRes1.body);

    // Drain confirmed booking cancellation jobs
    const drained = await refundService.drainPendingDepartureCancelJobs();
    expect(drained).toBe(5);

    expectedPrepaymentsMinor -= 5n * 500_000n;
    expectedRefundsPayableMinor += 5n * 500_000n;

    await refundService.processDueRefunds();
    await settleAllPendingMockRefunds();
    expectedRefundsPayableMinor -= 5n * 500_000n;
    expectedClearingMinor -= 5n * 500_000n;

    const sumRes = await fetch(`${baseUrl}/admin/departures/${departureId}/cancellation-summary`, {
      headers: { Cookie: adminCookie },
    });
    expect(sumRes.status).toBe(200);
    const summary = (await sumRes.json()) as DepartureCancellationSummaryDto;
    expect(summary.departureStatus).toBe('cancelled');
    expect(summary.bookings.cancelled).toBe(8);
    expect(summary.refunds.total).toBe(5);
    expect(summary.refunds.succeeded).toBe(5);

    const depDb = await testDb.pool.query<{ allocated: number }>(
      `SELECT allocated FROM inventory.departures WHERE id = $1::uuid`,
      [departureId],
    );
    expect(depDb.rows[0]?.allocated).toBe(0);
  });

  it('AC7: Late payment and double payment automatically create and settle refunds via payment.refund_required outbox', async () => {
    const u = await signUpAndSignIn('ac7-latedup@example.com', 'AC7 User', false, true);
    const { departureId, quote } = await createTourWithPolicyAndDeparture({
      prefix: 'AC7 LateDup',
      slugSuffix: 'ac7-latedup',
      capacity: 10,
      adultPrice: '650000',
    });

    // 1. Late payment (hold expires before webhook arrives)
    const lateHoldRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: u.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: { name: 'Late', email: 'late@example.com', phone: '+84901234567', locale: 'vi' },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    const lateHold = (await lateHoldRes.json()) as HoldBookingResponseDto;
    const lateCheckout = (await (
      await fetch(`${baseUrl}/bookings/${lateHold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: u.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;

    await fastForwardHoldExpiry(lateHold.id);
    await bookingService.expireDue({ limit: 5 });

    await fetch(`${baseUrl}${lateCheckout.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await drainInbox();
    expectedClearingMinor += 650_000n;
    expectedRefundsPayableMinor += 650_000n;

    // 2. Double payment (2 attempts on one booking both pay)
    const dupHoldRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: u.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: { name: 'Dup', email: 'dup@example.com', phone: '+84901234567', locale: 'vi' },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    const dupHold = (await dupHoldRes.json()) as HoldBookingResponseDto;
    const dupC1 = (await (
      await fetch(`${baseUrl}/bookings/${dupHold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: u.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;
    const dupC2 = (await (
      await fetch(`${baseUrl}/bookings/${dupHold.reference}/checkout`, {
        method: 'POST',
        headers: { Cookie: u.cookie, 'Idempotency-Key': nextIdemKey() },
      })
    ).json()) as InitiateCheckoutResponseDto;

    await fetch(`${baseUrl}${dupC1.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await drainInbox();
    expectedClearingMinor += 650_000n;
    expectedPrepaymentsMinor += 650_000n;

    await fetch(`${baseUrl}${dupC2.redirectUrl}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=success',
    });
    await drainInbox();
    expectedClearingMinor += 650_000n;
    expectedRefundsPayableMinor += 650_000n;

    // Outbox relay consumes payment.refund_required events -> creates 2 refund rows automatically
    await drainOutbox();

    const [lateRefund] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.paymentAttemptId, lateCheckout.attemptId));
    const [dupRefund] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.paymentAttemptId, dupC2.attemptId));

    expect(lateRefund?.reason).toBe('late_payment');
    expect(dupRefund?.reason).toBe('double_payment');

    await refundService.processDueRefunds();
    await settleAllPendingMockRefunds();
    expectedRefundsPayableMinor -= 2n * 650_000n;
    expectedClearingMinor -= 2n * 650_000n;

    const [lateDone] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.id, lateRefund!.id));
    const [dupDone] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.id, dupRefund!.id));
    expect(lateDone?.status).toBe('succeeded');
    expect(dupDone?.status).toBe('succeeded');
  });

  it('AC9: Authorization checks — other customer -> 404, customer on admin -> 403, anonymous -> 401', async () => {
    const { departureId, quote } = await createTourWithPolicyAndDeparture({
      prefix: 'AC9 Auth',
      slugSuffix: 'ac9-auth',
      capacity: 5,
    });
    const authUser = await signUpAndSignIn('ac9-owner@example.com', 'AC9 Owner', false, true);
    const holdRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authUser.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: { name: 'Auth', email: 'auth@example.com', phone: '+84901234567', locale: 'vi' },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    const hold = (await holdRes.json()) as HoldBookingResponseDto;

    // Anonymous -> 401
    expect(
      (
        await fetch(`${baseUrl}/bookings/${hold.reference}/cancel`, {
          method: 'POST',
          headers: { 'Idempotency-Key': nextIdemKey() },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/admin/departures/${departureId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': nextIdemKey() },
          body: JSON.stringify({ reason: 'test' }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/admin/refunds/${randomUUID()}/retry`, {
          method: 'POST',
          headers: { 'Idempotency-Key': nextIdemKey() },
        })
      ).status,
    ).toBe(401);

    // Other customer -> 404
    expect(
      (
        await fetch(`${baseUrl}/bookings/${hold.reference}/cancel`, {
          method: 'POST',
          headers: { Cookie: customerBCookie, 'Idempotency-Key': nextIdemKey() },
        })
      ).status,
    ).toBe(404);

    // Customer on admin endpoints -> 403
    expect(
      (
        await fetch(`${baseUrl}/admin/departures/${departureId}/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: customerBCookie,
            'Idempotency-Key': nextIdemKey(),
          },
          body: JSON.stringify({ reason: 'test' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/admin/refunds/${randomUUID()}/retry`, {
          method: 'POST',
          headers: { Cookie: customerBCookie, 'Idempotency-Key': nextIdemKey() },
        })
      ).status,
    ).toBe(403);
  });

  it('AC8: Final ledger audit — every journal entry balances per currency and all account balances match expected totals', async () => {
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
    const retainedAcc = await ledgerService.getAccountByCode('liability:cancellation_retained:VND');

    const clearingBal = await ledgerService.balance(clearingAcc!.id);
    const prepaymentsBal = await ledgerService.balance(prepaymentsAcc!.id);
    const refundsBal = await ledgerService.balance(refundsAcc!.id);
    const retainedBal = await ledgerService.balance(retainedAcc!.id);

    expect(clearingBal.amountMinor).toBe(expectedClearingMinor);
    expect(prepaymentsBal.amountMinor).toBe(expectedPrepaymentsMinor);
    expect(refundsBal.amountMinor).toBe(expectedRefundsPayableMinor);
    expect(retainedBal.amountMinor).toBe(expectedRetainedMinor);
    expect(clearingBal.amountMinor).toBe(
      prepaymentsBal.amountMinor + refundsBal.amountMinor + retainedBal.amountMinor,
    );
    expect(refundsBal.amountMinor).toBe(0n);
  });
});
