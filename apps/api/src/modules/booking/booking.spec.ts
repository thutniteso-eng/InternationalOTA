import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  applyRuntimeRoleGrants,
  createDbClient,
  type DatabaseClient,
  grantRoleByEmail,
  seedReferenceData,
} from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { createPinoLogger } from '../../common/observability/logger.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import type { AdminCatalogProductDto } from '../catalog/index.js';
import { type GenerateDeparturesResult, InventoryService } from '../inventory/index.js';
import { type PublicQuoteResponse } from '../pricing/index.js';
import type { SupplierRecord } from '../supply/index.js';
import { BookingService, parseBookingHoldMinutes } from './booking.service.js';
import type {
  BookingDetailDto,
  CustomerBookingListResponse,
  HoldBookingResponseDto,
} from './booking.types.js';

const TEST_AUTH_SECRET = 'p2-04-booking-holds-test-secret-32-chars-min';

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

describe('Booking aggregate, state machine & expiring holds (P2-04)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let bookingService: BookingService;
  let inventoryService: InventoryService;
  let rawLogBuffer = '';

  let adminCookie: string;
  let customerACookie: string;
  let customerAId: string;
  let customerBCookie: string;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousTrustedOrigins: string | undefined;
  let previousTrustedProxyCidrs: string | undefined;
  let previousBossDisabled: string | undefined;

  let idemSeq = 0;
  const nextIdemKey = () => `p2-04-key-${++idemSeq}`;

  let userIpSeq = 1;
  function nextForwardedIp(): string {
    const idx = userIpSeq++;
    const third = Math.floor(idx / 250);
    const fourth = (idx % 250) + 1;
    return `10.91.${third}.${fourth}`;
  }

  async function signUpAndSignIn(
    email: string,
    name: string,
    grantAdmin = false,
    emailVerified = false,
  ): Promise<{ cookie: string; userId: string }> {
    const forwardedIp = nextForwardedIp();
    const password = 'StrongBookingPass123!';
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

  async function getQuoteForPax(
    productId: string,
    departureId: string,
    adult: number,
    child = 0,
    infant = 0,
  ): Promise<PublicQuoteResponse> {
    const quoteRes = await fetch(
      `${baseUrl}/catalog/products/${productId}/quote?departureId=${departureId}&adult=${adult}&child=${child}&infant=${infant}&locale=vi`,
    );
    expect(quoteRes.status).toBe(200);
    return (await quoteRes.json()) as PublicQuoteResponse;
  }

  async function fastForwardHoldExpiry(bookingIds: string | readonly string[]): Promise<void> {
    const ids = Array.isArray(bookingIds) ? bookingIds : [bookingIds];
    const client = await testDb.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition');
      await client.query(
        `UPDATE booking.bookings SET hold_expires_at = now() - interval '2 minutes' WHERE id = ANY($1::uuid[])`,
        [ids],
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

  async function createTourWithPricePolicyAndDeparture(options: {
    prefix: string;
    slugSuffix: string;
    capacity: number;
    adultPrice?: string;
    childPrice?: string;
    bookingCutoffMinutes?: number;
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
          amountMinor: options.adultPrice ?? '950000',
          minAge: 10,
          occupiesSeat: true,
        },
        {
          paxType: 'child',
          amountMinor: options.childPrice ?? '650000',
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
        localTimes: ['08:00'],
        capacity: options.capacity,
        bookingCutoffMinutes: options.bookingCutoffMinutes ?? 60,
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

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousTrustedOrigins = process.env['AUTH_TRUSTED_ORIGINS'];
    previousTrustedProxyCidrs = process.env['TRUSTED_PROXY_CIDRS'];
    previousBossDisabled = process.env['PG_BOSS_DISABLED'];

    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3000,http://127.0.0.1';
    process.env['TRUSTED_PROXY_CIDRS'] = '127.0.0.1/32,::1/128';
    process.env['PG_BOSS_DISABLED'] = 'true';

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;
    await seedReferenceData(testDb.db);

    const logStream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        rawLogBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        callback();
      },
    });
    const pinoLogger = createPinoLogger({ destination: logStream, level: 'info' });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app, { logger: pinoLogger });
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
    bookingService = moduleFixture.get(BookingService);
    inventoryService = moduleFixture.get(InventoryService);

    adminCookie = (await signUpAndSignIn('booking-admin@example.com', 'Admin User', true, true))
      .cookie;
    const custA = await signUpAndSignIn('booking-cust-a@example.com', 'Customer A', false, false);
    customerACookie = custA.cookie;
    customerAId = custA.userId;
    const custB = await signUpAndSignIn('booking-cust-b@example.com', 'Customer B', false, true);
    customerBCookie = custB.cookie;
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    if (previousAuthSecret === undefined) delete process.env['BETTER_AUTH_SECRET'];
    else process.env['BETTER_AUTH_SECRET'] = previousAuthSecret;
    if (previousTrustedOrigins === undefined) delete process.env['AUTH_TRUSTED_ORIGINS'];
    else process.env['AUTH_TRUSTED_ORIGINS'] = previousTrustedOrigins;
    if (previousTrustedProxyCidrs === undefined) delete process.env['TRUSTED_PROXY_CIDRS'];
    else process.env['TRUSTED_PROXY_CIDRS'] = previousTrustedProxyCidrs;
    if (previousBossDisabled === undefined) delete process.env['PG_BOSS_DISABLED'];
    else process.env['PG_BOSS_DISABLED'] = previousBossDisabled;
    await testDb?.teardown();
  });

  it('AC1: Last seat — 50 concurrent customers contend for capacity=1; exactly 1 wins and 49 get 409 sold_out', async () => {
    const { departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'AC1 LastSeat',
      slugSuffix: 'ac1-last-seat',
      capacity: 1,
    });

    const customers: string[] = [];
    for (let i = 0; i < 50; i++) {
      const signed = await signUpAndSignIn(
        `ac1-racer-${i}@example.com`,
        `AC1 Racer ${i}`,
        false,
        true,
      );
      customers.push(signed.cookie);
    }

    const barrier = createStartBarrier(50);
    const results = await Promise.all(
      customers.map(async (cookie, idx) => {
        await barrier();
        const res = await fetch(`${baseUrl}/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            'Idempotency-Key': `ac1-race-${idx}`,
          },
          body: JSON.stringify({
            departureId,
            pax: { adult: 1, child: 0, infant: 0 },
            contact: {
              name: `Racer ${idx}`,
              email: `racer-${idx}@example.com`,
              phone: '+84900000001',
              locale: 'vi',
            },
            expectedSnapshotHash: quote.snapshotHash,
          }),
        });
        return {
          status: res.status,
          body: (await res.json()) as { code?: string; reference?: string },
        };
      }),
    );

    const winners = results.filter((r) => r.status === 201);
    const soldOut = results.filter((r) => r.status === 409 && r.body.code === 'sold_out');
    expect(winners).toHaveLength(1);
    expect(soldOut).toHaveLength(49);
    expect(winners[0]!.body.reference).toMatch(/^PQ-[0-9A-HJKMNP-TV-Z]{8}$/);

    const depRes = await testDb.pool.query<{ allocated: number }>(
      'SELECT allocated FROM inventory.departures WHERE id = $1',
      [departureId],
    );
    expect(depRes.rows[0]?.allocated).toBe(1);

    const bookingCountRes = await testDb.pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM booking.bookings WHERE departure_id = $1',
      [departureId],
    );
    expect(bookingCountRes.rows[0]?.cnt).toBe(1);

    const mismatch = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(mismatch.rows).toHaveLength(0);
  }, 60_000);

  it('AC2: Double submit with same Idempotency-Key + replay yields 1 booking; distinct key creates a 2nd hold', async () => {
    const { departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'AC2 DoubleSubmit',
      slugSuffix: 'ac2-double-submit',
      capacity: 10,
    });

    const user = await signUpAndSignIn('ac2-user@example.com', 'AC2 User', false, true);
    const payload = {
      departureId,
      pax: { adult: 1, child: 0, infant: 0 },
      contact: {
        name: 'Double Submit',
        email: 'ac2@example.com',
        phone: '+84900000002',
        locale: 'en',
      },
      expectedSnapshotHash: quote.snapshotHash,
    };

    const sameKey = nextIdemKey();
    const barrier = createStartBarrier(2);
    const concurrent = await Promise.all(
      [0, 1].map(async () => {
        await barrier();
        const res = await fetch(`${baseUrl}/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: user.cookie,
            'Idempotency-Key': sameKey,
          },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: (await res.json()) as HoldBookingResponseDto };
      }),
    );

    const createdCount = concurrent.filter((r) => r.status === 201).length;
    expect(createdCount).toBe(1);
    const firstSuccess = concurrent.find((r) => r.status === 201)!;

    // Replay returns identical 201 payload
    const replayRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: user.cookie,
        'Idempotency-Key': sameKey,
      },
      body: JSON.stringify(payload),
    });
    expect(replayRes.status).toBe(201);
    const replayBody = (await replayRes.json()) as HoldBookingResponseDto;
    expect(replayBody).toEqual(firstSuccess.body);

    // Distinct key creates second hold
    const secondRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: user.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify(payload),
    });
    expect(secondRes.status).toBe(201);
    const secondBody = (await secondRes.json()) as HoldBookingResponseDto;
    expect(secondBody.reference).not.toBe(firstSuccess.body.reference);

    const depRes = await testDb.pool.query<{ allocated: number }>(
      'SELECT allocated FROM inventory.departures WHERE id = $1',
      [departureId],
    );
    expect(depRes.rows[0]?.allocated).toBe(2);
  });

  it('AC3: Stale quote triggers 409 price_changed with fresh quote and writes zero rows/allocations', async () => {
    const {
      productId,
      departureId,
      quote: quoteV1,
    } = await createTourWithPricePolicyAndDeparture({
      prefix: 'AC3 PriceChange',
      slugSuffix: 'ac3-price-change',
      capacity: 10,
      adultPrice: '950000',
    });

    // Admin creates price list v2
    const v2 = await adminPost(`/admin/pricing/products/${productId}/price-lists`, {
      currency: 'VND',
      validFrom: '2026-01-01',
      items: [{ paxType: 'adult', amountMinor: '1250000', minAge: 10, occupiesSeat: true }],
    });
    expect(v2.status).toBe(201);

    const res = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerBCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Price Watcher',
          email: 'price@example.com',
          phone: '+84900000003',
          locale: 'vi',
        },
        expectedSnapshotHash: quoteV1.snapshotHash,
      }),
    });
    expect(res.status).toBe(409);
    const errBody = (await res.json()) as {
      code?: string;
      quote?: PublicQuoteResponse;
    };
    expect(errBody.code).toBe('price_changed');
    expect(errBody.quote?.totalAmountMinor).toBe('1250000');
    expect(errBody.quote?.snapshotHash).not.toBe(quoteV1.snapshotHash);

    const bookingCount = await testDb.pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM booking.bookings WHERE departure_id = $1',
      [departureId],
    );
    expect(bookingCount.rows[0]?.cnt).toBe(0);

    const depRes = await testDb.pool.query<{ allocated: number }>(
      'SELECT allocated FROM inventory.departures WHERE id = $1',
      [departureId],
    );
    expect(depRes.rows[0]?.allocated).toBe(0);

    // Closed departure rejects new holds with 422 closed
    await inventoryService.closeDeparture(departureId);
    const closedRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerBCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Closed Watcher',
          email: 'closed@example.com',
          phone: '+84900000003',
          locale: 'vi',
        },
        expectedSnapshotHash: errBody.quote!.snapshotHash,
      }),
    });
    expect(closedRes.status).toBe(422);
    expect(((await closedRes.json()) as { code?: string }).code).toBe('closed');
  });

  it('AC4: Single expiry + 30 concurrent expiry race + atomic release check', async () => {
    // Boot validation check for BOOKING_HOLD_MINUTES
    expect(parseBookingHoldMinutes(undefined)).toBe(15);
    expect(parseBookingHoldMinutes('5')).toBe(5);
    expect(() => parseBookingHoldMinutes('4')).toThrow(/5\.\.60/);
    expect(() => parseBookingHoldMinutes('61')).toThrow(/5\.\.60/);
    expect(() => parseBookingHoldMinutes('abc')).toThrow(/integer/);

    const { productId, departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'AC4 Expiry',
      slugSuffix: 'ac4-expiry',
      capacity: 100,
    });

    // 1. Single hold moved back to past -> expireDue releases seats & emits outbox + audit event
    const quoteTwoAdults = await getQuoteForPax(productId, departureId, 2, 0, 0);
    const single = await bookingService.createHold({
      customerUserId: customerAId,
      departureId,
      pax: { adult: 2, child: 0, infant: 0 },
      contact: {
        name: 'Expire Single',
        email: 'exp-single@example.com',
        phone: '+84900000004',
        locale: 'vi',
      },
      expectedSnapshotHash: quoteTwoAdults.snapshotHash,
    });
    expect(single.ok).toBe(true);
    if (!single.ok) return;

    await fastForwardHoldExpiry(single.booking.id);

    const expRes = await bookingService.expireDue({ limit: 10 });
    expect(expRes.expiredCount).toBe(1);

    const detail = await bookingService.getBookingForCustomerByReference(
      single.booking.reference,
      customerAId,
    );
    expect(detail.status).toBe('expired');
    expect(detail.expiredAt).not.toBeNull();
    expect(
      detail.events?.map((e) => `${e.fromStatus ?? 'null'}->${e.toStatus}:${e.actor}`),
    ).toEqual([`null->held:customer:${customerAId}`, 'held->expired:system:expiry']);

    const outboxRes = await testDb.pool.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at ASC`,
      [single.booking.id],
    );
    expect(outboxRes.rows.map((r) => r.event_type)).toEqual(['booking.held', 'booking.expired']);

    // 2. Concurrent expiry workers over 30 due bookings
    const dueIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const racer = await signUpAndSignIn(
        `ac4-batch-${i}@example.com`,
        `AC4 Batch ${i}`,
        false,
        true,
      );
      const created = await bookingService.createHold({
        customerUserId: racer.userId,
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: `Batch ${i}`,
          email: `batch-${i}@example.com`,
          phone: '+84900000010',
          locale: 'en',
        },
        expectedSnapshotHash: quote.snapshotHash,
      });
      expect(created.ok).toBe(true);
      if (created.ok) dueIds.push(created.booking.id);
    }

    await fastForwardHoldExpiry(dueIds);

    const barrier = createStartBarrier(2);
    const [w1, w2] = await Promise.all([
      (async () => {
        await barrier();
        return bookingService.expireDue({ limit: 50 });
      })(),
      (async () => {
        await barrier();
        return bookingService.expireDue({ limit: 50 });
      })(),
    ]);

    expect(w1.expiredCount + w2.expiredCount).toBe(30);
    expect(w1.skippedCount + w2.skippedCount).toBe(0);

    const depAfter = await testDb.pool.query<{ allocated: number }>(
      'SELECT allocated FROM inventory.departures WHERE id = $1',
      [departureId],
    );
    expect(depAfter.rows[0]?.allocated).toBe(0);

    const mismatch = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(mismatch.rows).toHaveLength(0);

    const expiredOutboxCount = await testDb.pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM platform.outbox_events WHERE event_type = 'booking.expired' AND aggregate_id = ANY($1::text[])`,
      [dueIds],
    );
    expect(expiredOutboxCount.rows[0]?.cnt).toBe(30);

    // 3. Atomic transaction check (Mutation e guard): holding departure lock blocks release AND booking commit together
    const atomicUser = await signUpAndSignIn('ac4-atomic@example.com', 'Atomic', false, true);
    const atomicHold = await bookingService.createHold({
      customerUserId: atomicUser.userId,
      departureId,
      pax: { adult: 2, child: 0, infant: 0 },
      contact: {
        name: 'Atomic Check',
        email: 'atomic@example.com',
        phone: '+84900000011',
        locale: 'en',
      },
      expectedSnapshotHash: quoteTwoAdults.snapshotHash,
    });
    expect(atomicHold.ok).toBe(true);
    if (!atomicHold.ok) return;
    await fastForwardHoldExpiry(atomicHold.booking.id);

    const locker = await testDb.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM inventory.departures WHERE id = $1 FOR UPDATE', [
        departureId,
      ]);

      const expPromise = bookingService.expireDue({ limit: 1 });
      await new Promise((r) => setTimeout(r, 80));

      // Observer outside sees booking is STILL held while release is blocked on departure lock
      const observed = await testDb.pool.query<{ status: string }>(
        'SELECT status FROM booking.bookings WHERE id = $1',
        [atomicHold.booking.id],
      );
      expect(observed.rows[0]?.status).toBe('held');

      await locker.query('COMMIT');
      const expAtomic = await expPromise;
      expect(expAtomic.expiredCount).toBe(1);
    } finally {
      locker.release();
    }
  }, 60_000);

  it('AC5: Expiry vs confirm race (20 iterations) — ends in one terminal state, seats released iff expired', async () => {
    const { departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'AC5 Race',
      slugSuffix: 'ac5-race',
      capacity: 40,
    });

    for (let i = 0; i < 20; i++) {
      const racer = await signUpAndSignIn(`ac5-racer-${i}@example.com`, `AC5 ${i}`, false, true);
      const hold = await bookingService.createHold({
        customerUserId: racer.userId,
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: `Race ${i}`,
          email: `race-${i}@example.com`,
          phone: '+84900000020',
          locale: 'vi',
        },
        expectedSnapshotHash: quote.snapshotHash,
      });
      expect(hold.ok).toBe(true);
      if (!hold.ok) return;

      const pending = await bookingService.markPaymentPending(hold.booking.id, racer.userId);
      expect(pending.ok).toBe(true);

      await fastForwardHoldExpiry(hold.booking.id);

      const barrier = createStartBarrier(2);
      const [confRes, expRes] = await Promise.all([
        (async () => {
          await barrier();
          return bookingService.confirm(hold.booking.id, `pay-ac5-${i}`);
        })(),
        (async () => {
          await barrier();
          return bookingService.expireDue({ limit: 5 });
        })(),
      ]);

      expect(expRes.expiredCount + (confRes.ok ? 1 : 0)).toBe(1);

      const rowRes = await testDb.pool.query<{ status: string }>(
        'SELECT status FROM booking.bookings WHERE id = $1',
        [hold.booking.id],
      );
      const finalStatus = rowRes.rows[0]!.status;
      const allocRes = await testDb.pool.query<{ state: string }>(
        `SELECT state FROM inventory.allocations WHERE ref_type = 'booking' AND ref_id = $1`,
        [hold.booking.id],
      );

      if (finalStatus === 'confirmed') {
        expect(confRes.ok).toBe(true);
        expect(allocRes.rows[0]?.state).toBe('active');
        // Idempotent confirm same paymentRef -> ok, different paymentRef -> conflict
        const replay = await bookingService.confirm(hold.booking.id, `pay-ac5-${i}`);
        expect(replay.ok).toBe(true);
        const conflict = await bookingService.confirm(hold.booking.id, `pay-other-${i}`);
        expect(conflict).toEqual({ ok: false, reason: 'conflict' });
      } else {
        expect(finalStatus).toBe('expired');
        expect(confRes).toEqual({ ok: false, reason: 'not_confirmable' });
        expect(allocRes.rows[0]?.state).toBe('released');
      }
    }

    const mismatch = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(mismatch.rows).toHaveLength(0);
  }, 60_000);

  it('AC6: DB transition trigger, optimistic version predicate (Mutation a), booking_events immutability, and ota_app grants', async () => {
    const { departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'AC6 DbGuards',
      slugSuffix: 'ac6-db-guards',
      capacity: 10,
    });

    const user = await signUpAndSignIn('ac6-user@example.com', 'AC6 User', false, true);
    const hold = await bookingService.createHold({
      customerUserId: user.userId,
      departureId,
      pax: { adult: 1, child: 0, infant: 0 },
      contact: {
        name: 'Guard Tester',
        email: 'guard@example.com',
        phone: '+84900000030',
        locale: 'en',
      },
      expectedSnapshotHash: quote.snapshotHash,
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;

    // 1. Direct held -> confirmed fails (23514)
    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings SET status = 'confirmed', payment_ref = 'p1', confirmed_at = now(), version = version + 1 WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/Illegal booking status transition/);

    // 2. Update without version bump fails (23514)
    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/version must increment/);

    // 3. Optimistic version check in transitionBooking (kills Mutation a)
    const pending = await bookingService.markPaymentPending(hold.booking.id, user.userId);
    expect(pending.ok).toBe(true);
    const staleAttempt = await bookingService.cancelBeforePayment(hold.booking.id, user.userId, {
      expectedVersion: 1,
    });
    expect(staleAttempt).toEqual({ ok: false, reason: 'not_cancellable' });

    // 4. confirmed without payment_ref fails (CHECK constraint / 23514)
    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings SET status = 'confirmed', confirmed_at = now(), version = version + 1 WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow();

    // 5. Move to expired -> illegal expired -> held fails
    await fastForwardHoldExpiry(hold.booking.id);
    await bookingService.expireDue({ limit: 5 });
    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings SET status = 'held', version = version + 1 WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/Illegal booking status transition/);

    // 6. booking_events UPDATE & DELETE blocked
    const evRes = await testDb.pool.query<{ id: string }>(
      `SELECT id FROM booking.booking_events WHERE booking_id = $1 LIMIT 1`,
      [hold.booking.id],
    );
    const eventId = evRes.rows[0]!.id;
    await expect(
      testDb.pool.query(`UPDATE booking.booking_events SET reason = 'tampered' WHERE id = $1`, [
        eventId,
      ]),
    ).rejects.toThrow(/insert-only/);
    await expect(
      testDb.pool.query(`DELETE FROM booking.booking_events WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/insert-only/);

    // 7. Least-privilege runtime role grants (SELECT/INSERT/UPDATE on bookings, SELECT/INSERT on booking_events)
    const testRole = 'ota_app_booking_test';
    await testDb.pool.query(`DROP OWNED BY ${testRole}`).catch(() => undefined);
    await testDb.pool.query(`DROP ROLE IF EXISTS ${testRole}`);
    await testDb.pool.query(`CREATE ROLE ${testRole} LOGIN PASSWORD 'rolepass'`);
    try {
      await applyRuntimeRoleGrants(testDb.db, testRole);
      const privRes = await testDb.pool.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'booking'
         ORDER BY table_name, privilege_type`,
        [testRole],
      );
      expect(privRes.rows).toEqual([
        { table_name: 'booking_events', privilege_type: 'INSERT' },
        { table_name: 'booking_events', privilege_type: 'SELECT' },
        { table_name: 'bookings', privilege_type: 'INSERT' },
        { table_name: 'bookings', privilege_type: 'SELECT' },
        { table_name: 'bookings', privilege_type: 'UPDATE' },
      ]);

      // Verify runtime role connection can select bookings & events
      const url = new URL(testDb.testUrl);
      url.username = testRole;
      url.password = 'rolepass';
      const runtimeClient = createDbClient({ connectionString: url.toString(), max: 1 });
      try {
        await runtimeClient.pool.query('SELECT COUNT(*) FROM booking.bookings');
        await runtimeClient.pool.query('SELECT COUNT(*) FROM booking.booking_events');
      } finally {
        await runtimeClient.pool.end();
      }
    } finally {
      await testDb.pool.query(`DROP OWNED BY ${testRole}; DROP ROLE IF EXISTS ${testRole};`);
    }
  });

  it('R1: DB transition trigger locks immutable snapshot/contact columns and gates payment_ref and status timestamps', async () => {
    const { departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'R1 ColumnLocks',
      slugSuffix: 'r1-column-locks',
      capacity: 20,
    });

    const user = await signUpAndSignIn('r1-user@example.com', 'R1 User', false, true);
    const hold = await bookingService.createHold({
      customerUserId: user.userId,
      departureId,
      pax: { adult: 1, child: 0, infant: 0 },
      contact: {
        name: 'Locked Traveler',
        email: 'locked@example.com',
        phone: '+84900000099',
        locale: 'en',
      },
      expectedSnapshotHash: quote.snapshotHash,
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;

    const immutableMutations: Array<{ label: string; setClause: string }> = [
      { label: 'seats', setClause: 'seats = 10' },
      { label: 'pax', setClause: `pax = '{"adult":10,"child":0,"infant":0}'::jsonb` },
      { label: 'hold_expires_at', setClause: `hold_expires_at = now() + interval '30 days'` },
      { label: 'quote_snapshot', setClause: `quote_snapshot = '{"tampered":true}'::jsonb` },
      { label: 'contact_name', setClause: `contact_name = 'Tampered Name'` },
      { label: 'contact_email', setClause: `contact_email = 'tampered@example.com'` },
      { label: 'contact_phone', setClause: `contact_phone = '+84911111111'` },
      { label: 'contact_locale', setClause: `contact_locale = 'vi'` },
      { label: 'created_at', setClause: `created_at = now() - interval '1 day'` },
    ];

    for (const { label, setClause } of immutableMutations) {
      await expect(
        testDb.pool.query(
          `UPDATE booking.bookings
           SET status = 'payment_pending', version = version + 1, ${setClause}
           WHERE id = $1`,
          [hold.booking.id],
        ),
        `modifying ${label} during held -> payment_pending should fail`,
      ).rejects.toThrow(/immutable core attributes/i);
    }

    // Setting payment_ref, confirmed_at, expired_at, or cancelled_at on the wrong transition must fail
    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings
         SET status = 'payment_pending', version = version + 1, payment_ref = 'early-ref'
         WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/payment_ref/i);

    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings
         SET status = 'payment_pending', version = version + 1, confirmed_at = now()
         WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/confirmed_at/i);

    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings
         SET status = 'payment_pending', version = version + 1, expired_at = now()
         WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/expired_at/i);

    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings
         SET status = 'payment_pending', version = version + 1, cancelled_at = now()
         WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/cancelled_at/i);

    // Setting payment_ref or confirmed_at on a transition to cancelled must also fail
    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings
         SET status = 'cancelled', version = version + 1, cancelled_at = now(), payment_ref = 'bad-ref'
         WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/payment_ref/i);

    // Legal transition held -> payment_pending succeeds cleanly when immutable columns stay untouched
    await testDb.pool.query(
      `UPDATE booking.bookings SET status = 'payment_pending', version = version + 1 WHERE id = $1`,
      [hold.booking.id],
    );

    // Attempting to set cancelled_at or expired_at while confirming must fail
    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings
         SET status = 'confirmed', version = version + 1, payment_ref = 'r1-pay-ref', confirmed_at = now(), cancelled_at = now()
         WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/cancelled_at/i);

    await expect(
      testDb.pool.query(
        `UPDATE booking.bookings
         SET status = 'confirmed', version = version + 1, payment_ref = 'r1-pay-ref', confirmed_at = now(), expired_at = now()
         WHERE id = $1`,
        [hold.booking.id],
      ),
    ).rejects.toThrow(/expired_at/i);

    // Legal transition payment_pending -> confirmed setting payment_ref (from NULL) and confirmed_at succeeds
    const confirmedRes = await testDb.pool.query<{
      status: string;
      payment_ref: string;
      version: number;
    }>(
      `UPDATE booking.bookings
       SET status = 'confirmed', version = version + 1, payment_ref = 'r1-pay-ref', confirmed_at = now()
       WHERE id = $1
       RETURNING status, payment_ref, version`,
      [hold.booking.id],
    );
    expect(confirmedRes.rows[0]).toEqual({
      status: 'confirmed',
      payment_ref: 'r1-pay-ref',
      version: 3,
    });
  });

  it('N3: BEFORE INSERT trigger on booking.bookings rejects pre-confirmed/invalid inserts and allows valid holds', async () => {
    const { productId, departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'N3 InsertGuard',
      slugSuffix: 'n3-insert-guard',
      capacity: 10,
    });
    const user = await signUpAndSignIn('n3-user@example.com', 'N3 User', false, true);

    const baseArgs = [
      user.userId,
      productId,
      departureId,
      JSON.stringify({ adult: 1, child: 0, infant: 0 }),
      JSON.stringify(quote),
      quote.snapshotHash,
    ];

    // 1. Direct INSERT with status='confirmed' (even with payment_ref and confirmed_at) MUST fail
    await expect(
      testDb.pool.query(
        `INSERT INTO booking.bookings (
          id, reference, customer_user_id, product_id, departure_id, status,
          pax, seats, currency, total_amount_minor, quote_snapshot, snapshot_hash,
          contact_name, contact_email, contact_phone, contact_locale, allocation_ref,
          hold_expires_at, payment_ref, version, confirmed_at
        ) VALUES (
          gen_random_uuid(), 'PQ-N3BAD001', $1, $2, $3, 'confirmed',
          $4::jsonb, 1, 'VND', 950000, $5::jsonb, $6,
          'Bad Actor', 'bad@example.com', '+84901234567', 'vi', 'alloc-n3-1',
          now() + interval '15 minutes', 'pay-fake', 1, now()
        )`,
        baseArgs,
      ),
    ).rejects.toThrow(/status "held"/i);

    // 2. Direct INSERT with version <> 1 MUST fail
    await expect(
      testDb.pool.query(
        `INSERT INTO booking.bookings (
          id, reference, customer_user_id, product_id, departure_id, status,
          pax, seats, currency, total_amount_minor, quote_snapshot, snapshot_hash,
          contact_name, contact_email, contact_phone, contact_locale, allocation_ref,
          hold_expires_at, version
        ) VALUES (
          gen_random_uuid(), 'PQ-N3BAD002', $1, $2, $3, 'held',
          $4::jsonb, 1, 'VND', 950000, $5::jsonb, $6,
          'Bad Actor', 'bad@example.com', '+84901234567', 'vi', 'alloc-n3-2',
          now() + interval '15 minutes', 2
        )`,
        baseArgs,
      ),
    ).rejects.toThrow(/version 1/i);

    // 3. Direct INSERT with non-null payment_ref or terminal timestamp while held MUST fail
    await expect(
      testDb.pool.query(
        `INSERT INTO booking.bookings (
          id, reference, customer_user_id, product_id, departure_id, status,
          pax, seats, currency, total_amount_minor, quote_snapshot, snapshot_hash,
          contact_name, contact_email, contact_phone, contact_locale, allocation_ref,
          hold_expires_at, payment_ref, version
        ) VALUES (
          gen_random_uuid(), 'PQ-N3BAD003', $1, $2, $3, 'held',
          $4::jsonb, 1, 'VND', 950000, $5::jsonb, $6,
          'Bad Actor', 'bad@example.com', '+84901234567', 'vi', 'alloc-n3-3',
          now() + interval '15 minutes', 'sneaky-ref', 1
        )`,
        baseArgs,
      ),
    ).rejects.toThrow(/payment_ref or terminal timestamps/i);

    // 4. Direct INSERT with hold_expires_at <= now() MUST fail
    await expect(
      testDb.pool.query(
        `INSERT INTO booking.bookings (
          id, reference, customer_user_id, product_id, departure_id, status,
          pax, seats, currency, total_amount_minor, quote_snapshot, snapshot_hash,
          contact_name, contact_email, contact_phone, contact_locale, allocation_ref,
          hold_expires_at, version
        ) VALUES (
          gen_random_uuid(), 'PQ-N3BAD004', $1, $2, $3, 'held',
          $4::jsonb, 1, 'VND', 950000, $5::jsonb, $6,
          'Bad Actor', 'bad@example.com', '+84901234567', 'vi', 'alloc-n3-4',
          now() - interval '1 minute', 1
        )`,
        baseArgs,
      ),
    ).rejects.toThrow(/hold_expires_at/i);

    // 5. Normal createHold still inserts cleanly under the trigger
    const validHold = await bookingService.createHold({
      customerUserId: user.userId,
      departureId,
      pax: { adult: 1, child: 0, infant: 0 },
      contact: {
        name: 'Valid Guest',
        email: 'valid-n3@example.com',
        phone: '+84901234568',
        locale: 'vi',
      },
      expectedSnapshotHash: quote.snapshotHash,
    });
    expect(validHold.ok).toBe(true);
  });

  it('AC7 & AC8 & AC9 & AC10 & AC11: D-018, auth/ownership 404/401/403, anti-hoarding, cancel, PII redaction, and static write guard', async () => {
    const { departureId, quote } = await createTourWithPricePolicyAndDeparture({
      prefix: 'AC7-11',
      slugSuffix: 'ac7-11',
      capacity: 20,
    });

    // AC7: Customer A starts unverified -> createHold works, markPaymentPending fails email_not_verified (403)
    const unverifiedHold = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerACookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Secret PII Traveler AC11',
          email: 'secret-pii-ac11@example.com',
          phone: '+84987654321',
          locale: 'vi',
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(unverifiedHold.status).toBe(201);
    const createdHold = (await unverifiedHold.json()) as HoldBookingResponseDto;

    // AC11: request/response logs must contain ZERO contact PII
    expect(rawLogBuffer).not.toContain('Secret PII Traveler AC11');
    expect(rawLogBuffer).not.toContain('secret-pii-ac11@example.com');
    expect(rawLogBuffer).not.toContain('+84987654321');

    const failPayPending = await fetch(
      `${baseUrl}/bookings/${createdHold.reference}/payment-pending`,
      {
        method: 'POST',
        headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
      },
    );
    expect(failPayPending.status).toBe(403);
    const failPayErr = (await failPayPending.json()) as { code?: string };
    expect(failPayErr.code).toBe('email_not_verified');

    // Verify Customer A's email -> payment-pending succeeds while keeping holdExpiresAt untouched
    await testDb.pool.query(`UPDATE identity."user" SET email_verified = true WHERE id = $1`, [
      customerAId,
    ]);
    const okPayPending = await fetch(
      `${baseUrl}/bookings/${createdHold.reference}/payment-pending`,
      {
        method: 'POST',
        headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
      },
    );
    expect(okPayPending.status).toBe(200);
    const pendingDto = (await okPayPending.json()) as BookingDetailDto;
    expect(pendingDto.status).toBe('payment_pending');
    expect(pendingDto.holdExpiresAt).toBe(createdHold.holdExpiresAt);

    // AC8: Authorization checks (anonymous 401, other customer 404, non-admin 403)
    const anonCreate = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': nextIdemKey() },
      body: JSON.stringify({}),
    });
    expect(anonCreate.status).toBe(401);

    const anonAdmin = await fetch(`${baseUrl}/admin/bookings`);
    expect(anonAdmin.status).toBe(401);

    const custAdmin = await fetch(`${baseUrl}/admin/bookings`, {
      headers: { Cookie: customerACookie },
    });
    expect(custAdmin.status).toBe(403);

    const otherGet = await fetch(`${baseUrl}/bookings/${createdHold.reference}`, {
      headers: { Cookie: customerBCookie },
    });
    expect(otherGet.status).toBe(404);

    const otherCancel = await fetch(`${baseUrl}/bookings/${createdHold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerBCookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(otherCancel.status).toBe(404);

    // Admin list filters work
    const adminByRef = await fetch(
      `${baseUrl}/admin/bookings?status=payment_pending&reference=${createdHold.reference}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(adminByRef.status).toBe(200);
    const adminJson = (await adminByRef.json()) as CustomerBookingListResponse;
    expect(adminJson.items.some((b) => b.reference === createdHold.reference)).toBe(true);

    // AC10: Cancel before payment -> releases seats once; second cancel -> 200 idempotent no-op
    const cancel1 = await fetch(`${baseUrl}/bookings/${createdHold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(cancel1.status).toBe(200);
    const cancelledDto = (await cancel1.json()) as BookingDetailDto;
    expect(cancelledDto.status).toBe('cancelled');

    const cancel2 = await fetch(`${baseUrl}/bookings/${createdHold.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerACookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(cancel2.status).toBe(200);

    // Confirmed booking cannot be cancelled before payment -> 409
    const confUser = await signUpAndSignIn('ac10-conf@example.com', 'AC10 Conf', false, true);
    const holdForConf = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: confUser.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Conf User',
          email: 'conf@example.com',
          phone: '+84900000040',
          locale: 'en',
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(holdForConf.status).toBe(201);
    const confHoldBody = (await holdForConf.json()) as HoldBookingResponseDto;
    await fetch(`${baseUrl}/bookings/${confHoldBody.reference}/payment-pending`, {
      method: 'POST',
      headers: { Cookie: confUser.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    const confirmed = await bookingService.confirm(confHoldBody.id, 'pay-ac10-1');
    expect(confirmed.ok).toBe(true);

    // cancelBeforePayment rejects confirmed bookings (pre-payment cancel guard remains intact)
    const cancelBeforePay = await bookingService.cancelBeforePayment(
      confHoldBody.id,
      confUser.userId,
    );
    expect(cancelBeforePay).toEqual({ ok: false, reason: 'not_cancellable' });

    // Expired booking cannot be cancelled via HTTP -> 409
    await fastForwardHoldExpiry(createdHold.id);
    const expHoldRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: confUser.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Exp User',
          email: 'exp@example.com',
          phone: '+84900000041',
          locale: 'en',
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(expHoldRes.status).toBe(201);
    const expHoldBody = (await expHoldRes.json()) as HoldBookingResponseDto;
    await fastForwardHoldExpiry(expHoldBody.id);
    await bookingService.expireDue({ limit: 5 });

    const cancelExpired = await fetch(`${baseUrl}/bookings/${expHoldBody.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: confUser.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(cancelExpired.status).toBe(409);

    // AC9: Anti-hoarding sequential + cancel recovery + concurrent 4-hold burst
    const hoardSeqUser = await signUpAndSignIn('ac9-seq@example.com', 'AC9 Seq', false, true);
    const createdRefs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: hoardSeqUser.cookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({
          departureId,
          pax: { adult: 1, child: 0, infant: 0 },
          contact: {
            name: 'Hoard Seq',
            email: 'hoard-seq@example.com',
            phone: '+84900000050',
            locale: 'en',
          },
          expectedSnapshotHash: quote.snapshotHash,
        }),
      });
      expect(r.status).toBe(201);
      createdRefs.push(((await r.json()) as HoldBookingResponseDto).reference);
    }

    // 4th returns 409 too_many_active_holds
    const fourthRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: hoardSeqUser.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Hoard Seq',
          email: 'hoard-seq@example.com',
          phone: '+84900000050',
          locale: 'en',
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(fourthRes.status).toBe(409);
    expect(((await fourthRes.json()) as { code?: string }).code).toBe('too_many_active_holds');

    // Cancel 1 -> next succeeds (and GET /me/bookings sees all own bookings paginated)
    await fetch(`${baseUrl}/bookings/${createdRefs[0]}/cancel`, {
      method: 'POST',
      headers: { Cookie: hoardSeqUser.cookie, 'Idempotency-Key': nextIdemKey() },
    });
    const retryAfterCancel = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: hoardSeqUser.cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Hoard Seq',
          email: 'hoard-seq@example.com',
          phone: '+84900000050',
          locale: 'en',
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(retryAfterCancel.status).toBe(201);

    // Concurrent 4 holds by one customer -> max 3 succeed
    const hoardRaceUser = await signUpAndSignIn('ac9-race@example.com', 'AC9 Race', false, true);
    const hoardBarrier = createStartBarrier(4);
    const hoardRace = await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        await hoardBarrier();
        const r = await fetch(`${baseUrl}/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: hoardRaceUser.cookie,
            'Idempotency-Key': `ac9-race-k-${i}`,
          },
          body: JSON.stringify({
            departureId,
            pax: { adult: 1, child: 0, infant: 0 },
            contact: {
              name: 'Hoard Race',
              email: 'hoard-race@example.com',
              phone: '+84900000051',
              locale: 'vi',
            },
            expectedSnapshotHash: quote.snapshotHash,
          }),
        });
        return { status: r.status, body: (await r.json()) as { code?: string } };
      }),
    );
    expect(hoardRace.filter((r) => r.status === 201)).toHaveLength(3);
    expect(
      hoardRace.filter((r) => r.status === 409 && r.body.code === 'too_many_active_holds'),
    ).toHaveLength(1);

    // GET /me/bookings cursor pagination sees only own 3 bookings for hoardRaceUser
    const page1Res = await fetch(`${baseUrl}/me/bookings?limit=2`, {
      headers: { Cookie: hoardRaceUser.cookie },
    });
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as CustomerBookingListResponse;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2Res = await fetch(`${baseUrl}/me/bookings?limit=2&cursor=${page1.nextCursor}`, {
      headers: { Cookie: hoardRaceUser.cookie },
    });
    const page2 = (await page2Res.json()) as CustomerBookingListResponse;
    expect(page2.items).toHaveLength(1);
    const allOwnIds = new Set([...page1.items, ...page2.items].map((b) => b.id));
    expect(allOwnIds.size).toBe(3);

    // Static write-isolation guard: no code outside BookingService.transitionBooking updates booking.bookings
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const externalOffenders: string[] = [];
    const scanDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const content = readFileSync(full, 'utf8');
          const updatesBookingTable =
            /\.update\(\s*bookingBookings\s*\)|UPDATE\s+booking\.bookings/i.test(content);
          if (updatesBookingTable && !full.endsWith('/booking/booking.service.ts')) {
            externalOffenders.push(full);
          }
        }
      }
    };
    scanDir(srcRoot);
    expect(externalOffenders).toEqual([]);

    const serviceSrc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'booking.service.ts'),
      'utf8',
    );
    const updateMatches = serviceSrc.match(/\.update\(\s*bookingBookings\s*\)/g) ?? [];
    expect(updateMatches).toHaveLength(1);
  }, 60_000);
});
