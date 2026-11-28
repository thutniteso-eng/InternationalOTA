import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  and,
  type DatabaseClient,
  eq,
  grantRoleByEmail,
  inventoryDepartures,
  opsAdminAudit,
  opsReconciliationFindings,
  opsReconciliationRuns,
  outboxEvents,
  paymentsRefunds,
  seedReferenceData,
} from '@internationalota/db';
import { type INestApplication, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { I18nModule } from '../../common/i18n/i18n.module.js';
import { createPinoLogger } from '../../common/observability/logger.js';
import { DatabaseModule, DRIZZLE_DB } from '../../database/database.module.js';
import { AdminGrantProductionForbiddenError, runAdminGrant } from '../../scripts/admin-grant.js';
import {
  cleanupDeadLetteredNoConsumerOutbox,
  StagingOutboxCleanupProductionForbiddenError,
} from '../../scripts/staging-outbox-cleanup.js';
import { type HoldBookingResponseDto } from '../booking/index.js';
import { type AdminCatalogProductDto, CatalogModule } from '../catalog/index.js';
import { IdempotencyModule } from '../idempotency/index.js';
import { IdentityModule } from '../identity/index.js';
import {
  type GenerateDeparturesResult,
  InventoryModule,
  InventoryService,
} from '../inventory/index.js';
import {
  InboxService,
  OUTBOX_EVENTS_WITHOUT_CONSUMERS,
  OutboxService,
} from '../messaging/index.js';
import {
  type InitiateCheckoutResponseDto,
  MockPaymentProvider,
  RefundService,
} from '../payments/index.js';
import type { PublicQuoteResponse } from '../pricing/index.js';
import { type SupplierRecord, SupplyModule } from '../supply/index.js';
import {
  OpsService,
  type AdminDashboardDto,
  type ReconciliationRunDetailDto,
  type ReconciliationRunListResponse,
} from './index.js';

const TEST_AUTH_SECRET = 'p2-10-ops-reconciliation-test-secret-min-32';
const TEST_MOCK_PSP_SECRET = 'p2-10-mock-psp-secret-key-at-least-32-chars';

function extractCookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

function futureUtcDateString(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

function createBarrier(parties: number) {
  let arrived = 0;
  let releaseAll!: () => void;
  const gate = new Promise<void>((res) => {
    releaseAll = res;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) {
      releaseAll();
    }
    await gate;
  };
}

describe('Ops Daily Reconciliation & Minimal Admin Console (P2-10)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let opsService: OpsService;
  let outboxService: OutboxService;
  let inboxService: InboxService;
  let refundService: RefundService;
  let mockProvider: MockPaymentProvider;

  let adminCookie: string;
  let customerCookie: string;
  let customerId: string;
  let operatorCookie: string;
  let operatorEmail: string;

  let productId: string;
  let departureId: string;
  let happyRef: string;
  let cancelledRef: string;
  let manualReviewRefundId: string;
  let overdueBookingId: string;

  let prevDbUrl: string | undefined;
  let prevAuthSecret: string | undefined;
  let prevTrustedOrigins: string | undefined;
  let prevTrustedProxyCidrs: string | undefined;
  let prevBossDisabled: string | undefined;
  let prevMockEnabled: string | undefined;
  let prevMockSecret: string | undefined;
  let prevAppEnv: string | undefined;

  let idemSeq = 0;
  const nextIdemKey = () => `p2-10-key-${++idemSeq}`;

  let ipSeq = 1;
  const nextIp = () => `10.97.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

  async function signUpAndSignIn(
    email: string,
    name: string,
    role?: 'admin' | 'operator',
    verified = true,
  ): Promise<{ cookie: string; userId: string }> {
    const ip = nextIp();
    const password = 'StrongOpsPass123!';
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

    if (role) {
      await grantRoleByEmail(db, email, role);
    }

    const rowRes = await testDb.pool.query<{ id: string }>(
      `SELECT id FROM identity."user" WHERE email = $1`,
      [email],
    );
    const userId = rowRes.rows[0]!.id;
    if (verified) {
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

  async function adminPost<T>(
    path: string,
    body?: unknown,
    cookie = adminCookie,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function adminPut<T>(
    path: string,
    body: unknown,
    cookie = adminCookie,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function createAndPayBooking(
    userCookie: string,
    targetDepartureId: string,
    contactName: string,
  ): Promise<{ reference: string; bookingId: string; attemptId: string; providerRef: string }> {
    const quoteRes = await fetch(
      `${baseUrl}/catalog/products/${productId}/quote?departureId=${targetDepartureId}&adult=1&child=0&infant=0&locale=vi`,
    );
    expect(quoteRes.status).toBe(200);
    const quote = (await quoteRes.json()) as PublicQuoteResponse;

    const holdRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: userCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId: targetDepartureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: contactName,
          email: `${contactName.toLowerCase().replace(/\s+/g, '-')}@example.com`,
          phone: '+84900001234',
          locale: 'vi',
        },
        expectedSnapshotHash: quote.snapshotHash,
      }),
    });
    expect(holdRes.status).toBe(201);
    const hold = (await holdRes.json()) as HoldBookingResponseDto;

    const checkoutRes = await fetch(`${baseUrl}/bookings/${hold.reference}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: userCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({ provider: 'mock' }),
    });
    expect(checkoutRes.status).toBe(200);
    const checkout = (await checkoutRes.json()) as InitiateCheckoutResponseDto;

    const actRes = await fetch(`${baseUrl}/mock-psp/checkout/${checkout.providerRef}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'success' }),
    });
    expect(actRes.status).toBe(303);
    await inboxService.relayBatch();
    await outboxService.relayBatch();

    return {
      reference: hold.reference,
      bookingId: hold.id,
      attemptId: checkout.attemptId,
      providerRef: checkout.providerRef,
    };
  }

  async function drainAllOutbox(): Promise<void> {
    while ((await outboxService.relayBatch()) > 0) {
      // drain
    }
  }

  beforeAll(async () => {
    prevDbUrl = process.env['DATABASE_URL'];
    prevAuthSecret = process.env['BETTER_AUTH_SECRET'];
    prevTrustedOrigins = process.env['AUTH_TRUSTED_ORIGINS'];
    prevTrustedProxyCidrs = process.env['TRUSTED_PROXY_CIDRS'];
    prevBossDisabled = process.env['PG_BOSS_DISABLED'];
    prevMockEnabled = process.env['MOCK_PAYMENT_ENABLED'];
    prevMockSecret = process.env['MOCK_PSP_WEBHOOK_SECRET'];
    prevAppEnv = process.env['APP_ENV'];

    testDb = await createTestDatabase();
    await seedReferenceData(testDb.db);

    process.env['NODE_ENV'] = 'test';
    process.env['APP_ENV'] = 'test';
    process.env['DATABASE_URL'] = testDb.testUrl;
    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3000,http://127.0.0.1';
    process.env['TRUSTED_PROXY_CIDRS'] = '127.0.0.1/32,::1/128';
    process.env['PG_BOSS_DISABLED'] = 'true';
    process.env['MOCK_PAYMENT_ENABLED'] = 'true';
    process.env['MOCK_PSP_SECRET'] = TEST_MOCK_PSP_SECRET;
    process.env['MOCK_PSP_WEBHOOK_SECRET'] = TEST_MOCK_PSP_SECRET;

    const pinoLogger = createPinoLogger({
      destination: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
      level: 'silent',
    });

    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = mod.createNestApplication({ bodyParser: false });
    configureApp(app, { logger: pinoLogger });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    db = app.get<DatabaseClient>(DRIZZLE_DB);
    opsService = app.get(OpsService);
    outboxService = app.get(OutboxService);
    inboxService = app.get(InboxService);
    refundService = app.get(RefundService);
    mockProvider = app.get(MockPaymentProvider);

    const admin = await signUpAndSignIn('ops-admin@example.com', 'Ops Admin', 'admin', true);
    adminCookie = admin.cookie;

    const customer = await signUpAndSignIn('ops-cust@example.com', 'Ops Customer', undefined, true);
    customerCookie = customer.cookie;
    customerId = customer.userId;

    operatorEmail = 'ops-operator@example.com';
    const op = await signUpAndSignIn(operatorEmail, 'Ops Operator', undefined, true);
    operatorCookie = op.cookie;

    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: 'Ops Test Supplier',
      countryAlpha2: 'VN',
    });
    expect(sup.status).toBe(201);

    const prod = await adminPost<AdminCatalogProductDto>('/admin/products', {
      supplierId: sup.body.id,
      kind: 'tour',
      countryAlpha2: 'VN',
      region: 'Phú Quốc',
      location: { lat: 10.22, lng: 103.96 },
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    expect(prod.status).toBe(201);
    productId = prod.body.id;

    await adminPut(`/admin/products/${productId}/translations/vi`, {
      title: 'Tour Ops Test',
      slug: 'tour-ops-test',
      summary: 'Tóm tắt',
      description: 'Mô tả',
    });
    await adminPut(`/admin/products/${productId}/translations/en`, {
      title: 'Ops Test Tour',
      slug: 'ops-test-tour',
      summary: 'Summary',
      description: 'Description',
    });
    await adminPost(`/admin/products/${productId}/publish`);

    await adminPost(`/admin/pricing/products/${productId}/price-lists`, {
      currency: 'VND',
      validFrom: '2026-01-01',
      items: [
        { paxType: 'adult', amountMinor: '1000000', minAge: 10, occupiesSeat: true },
        { paxType: 'child', amountMinor: '700000', minAge: 5, maxAge: 9, occupiesSeat: true },
        { paxType: 'infant', amountMinor: '0', minAge: 0, maxAge: 4, occupiesSeat: false },
      ],
    });
    await adminPost(`/admin/pricing/products/${productId}/cancellation-policies`, {
      rules: [
        { hoursBeforeStart: 24, refundPercent: 100 },
        { hoursBeforeStart: 0, refundPercent: 0 },
      ],
    });

    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: futureUtcDateString(10),
        toDate: futureUtcDateString(12),
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['09:00'],
        capacity: 30,
        bookingCutoffMinutes: 60,
      },
    );
    expect(gen.status).toBe(200);
    departureId = gen.body.createdIds[0]!;
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (prevDbUrl !== undefined) process.env['DATABASE_URL'] = prevDbUrl;
    else delete process.env['DATABASE_URL'];
    if (prevAuthSecret !== undefined) process.env['BETTER_AUTH_SECRET'] = prevAuthSecret;
    else delete process.env['BETTER_AUTH_SECRET'];
    if (prevTrustedOrigins !== undefined) process.env['AUTH_TRUSTED_ORIGINS'] = prevTrustedOrigins;
    else delete process.env['AUTH_TRUSTED_ORIGINS'];
    if (prevTrustedProxyCidrs !== undefined) {
      process.env['TRUSTED_PROXY_CIDRS'] = prevTrustedProxyCidrs;
    } else {
      delete process.env['TRUSTED_PROXY_CIDRS'];
    }
    if (prevBossDisabled !== undefined) process.env['PG_BOSS_DISABLED'] = prevBossDisabled;
    else delete process.env['PG_BOSS_DISABLED'];
    if (prevMockEnabled !== undefined) process.env['MOCK_PAYMENT_ENABLED'] = prevMockEnabled;
    else delete process.env['MOCK_PAYMENT_ENABLED'];
    if (prevMockSecret !== undefined) process.env['MOCK_PSP_WEBHOOK_SECRET'] = prevMockSecret;
    else delete process.env['MOCK_PSP_WEBHOOK_SECRET'];
    if (prevAppEnv !== undefined) process.env['APP_ENV'] = prevAppEnv;
    else delete process.env['APP_ENV'];
    await testDb?.teardown();
  });

  it('AC1: Clean run across happy, cancel, late-payment & double-payment flows returns ok with 0 errors and balanced ledger', async () => {
    // 1. Happy booking
    const happy = await createAndPayBooking(customerCookie, departureId, 'Happy Guest');
    happyRef = happy.reference;

    // 2. Customer cancellation + refund settled
    const cancelFlow = await createAndPayBooking(customerCookie, departureId, 'Cancel Guest');
    cancelledRef = cancelFlow.reference;
    const cancelRes = await fetch(`${baseUrl}/bookings/${cancelFlow.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerCookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(cancelRes.status).toBe(200);
    await refundService.processDueRefunds();
    await inboxService.relayBatch();
    await drainAllOutbox();

    // 3. Double payment flow (two concurrent initiated attempts on one booking, both pay)
    const dblQuoteRes = await fetch(
      `${baseUrl}/catalog/products/${productId}/quote?departureId=${departureId}&adult=1&child=0&infant=0&locale=vi`,
    );
    const dblQuote = (await dblQuoteRes.json()) as PublicQuoteResponse;
    const dblHoldRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Double Pay Guest',
          email: 'dbl@example.com',
          phone: '+84900001111',
          locale: 'vi',
        },
        expectedSnapshotHash: dblQuote.snapshotHash,
      }),
    });
    const dblHold = (await dblHoldRes.json()) as HoldBookingResponseDto;

    const c1 = (await (
      await fetch(`${baseUrl}/bookings/${dblHold.reference}/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: customerCookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({ provider: 'mock' }),
      })
    ).json()) as InitiateCheckoutResponseDto;
    const c2 = (await (
      await fetch(`${baseUrl}/bookings/${dblHold.reference}/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: customerCookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({ provider: 'mock' }),
      })
    ).json()) as InitiateCheckoutResponseDto;

    await fetch(`${baseUrl}/mock-psp/checkout/${c1.providerRef}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'success' }),
    });
    await fetch(`${baseUrl}/mock-psp/checkout/${c2.providerRef}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'success' }),
    });
    await inboxService.relayBatch();
    await drainAllOutbox();
    await refundService.processDueRefunds();
    await inboxService.relayBatch();
    await drainAllOutbox();

    // 4. Late payment flow: hold expires before callback arrives
    const lateHoldRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Late Guest',
          email: 'late@example.com',
          phone: '+84900002222',
          locale: 'vi',
        },
        expectedSnapshotHash: dblQuote.snapshotHash,
      }),
    });
    const lateHold = (await lateHoldRes.json()) as HoldBookingResponseDto;
    const lateChk = (await (
      await fetch(`${baseUrl}/bookings/${lateHold.reference}/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: customerCookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({ provider: 'mock' }),
      })
    ).json()) as InitiateCheckoutResponseDto;

    // Expire the hold cleanly using booking expire worker after fast-forward
    await testDb.pool.query('BEGIN');
    await testDb.pool.query('ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition');
    await testDb.pool.query(
      `UPDATE booking.bookings SET hold_expires_at = now() - interval '2 minutes' WHERE id = $1`,
      [lateHold.id],
    );
    await testDb.pool.query('ALTER TABLE booking.bookings ENABLE TRIGGER trg_bookings_transition');
    await testDb.pool.query('COMMIT');
    await testDb.pool.query(
      `UPDATE booking.bookings SET hold_expires_at = hold_expires_at WHERE false`,
    );
    await fetch(`${baseUrl}/mock-psp/checkout/${lateChk.providerRef}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'success' }),
    });
    // Run expiry directly via BookingService public API before processing late callback
    const { BookingService } = await import('../booking/index.js');
    await app.get(BookingService).expireDue({ limit: 50 });
    await inboxService.relayBatch();
    await drainAllOutbox();
    await refundService.processDueRefunds();
    await inboxService.relayBatch();
    await drainAllOutbox();

    // Run reconciliation cleanly via HTTP POST /admin/reconciliation/runs
    const runRes = await adminPost<ReconciliationRunDetailDto>('/admin/reconciliation/runs', {
      reason: 'AC1 clean verification',
    });
    expect(runRes.status).toBe(200);
    expect(runRes.body.run.status).toBe('ok');
    expect(runRes.body.run.counts.errors).toBe(0);
    expect(runRes.body.run.counts.warnings).toBe(0);
    expect(runRes.body.findings).toEqual([]);

    // Verify GET /admin/dashboard & GET /admin/bookings/:reference & PII list redaction
    const dashRes = await fetch(`${baseUrl}/admin/dashboard`, {
      headers: { Cookie: adminCookie },
    });
    expect(dashRes.status).toBe(200);
    const dash = (await dashRes.json()) as AdminDashboardDto;
    expect(dash.today.byStatus.confirmed).toBeGreaterThanOrEqual(2);
    expect(dash.latestReconciliation?.id).toBe(runRes.body.run.id);

    const listRes = await fetch(`${baseUrl}/admin/bookings?productId=${productId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      items: Array<{ contactName: string; contactEmail: string; contactPhone: string }>;
    };
    expect(listBody.items.length).toBeGreaterThanOrEqual(3);
    for (const item of listBody.items) {
      expect(item.contactName.length).toBeGreaterThan(0);
      expect(item.contactEmail).toBe('');
      expect(item.contactPhone).toBe('');
    }

    const detailRes = await fetch(`${baseUrl}/admin/bookings/${happyRef}`, {
      headers: { Cookie: adminCookie },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      contactEmail: string;
      events: unknown[];
      attempts: unknown[];
      refunds: unknown[];
      emails: Array<Record<string, unknown>>;
    };
    expect(detail.contactEmail).toContain('@example.com');
    expect(detail.events.length).toBeGreaterThanOrEqual(2);
    expect(detail.attempts.length).toBe(1);
    expect(detail.emails.every((e) => !('recipientHash' in e))).toBe(true);

    // Verify ops triggers enforce immutability on findings, audit, and finished runs
    await expect(
      testDb.pool.query(`UPDATE ops.admin_audit SET reason = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      testDb.pool.query(`UPDATE ops.reconciliation_runs SET status = 'failed' WHERE id = $1`, [
        runRes.body.run.id,
      ]),
    ).rejects.toThrow(/cannot be modified/);
  }, 60_000);

  it('AC5: Reconciliation run is strictly read-only outside ops schema tables', async () => {
    const countsQuery = `
      SELECT
        (SELECT COUNT(*)::int FROM inventory.departures) AS deps,
        (SELECT COALESCE(SUM(allocated), 0)::int FROM inventory.departures) AS alloc_sum,
        (SELECT COUNT(*)::int FROM booking.bookings) AS bookings,
        (SELECT COUNT(*)::int FROM payments.payment_attempts) AS attempts,
        (SELECT COUNT(*)::int FROM payments.refunds) AS refunds,
        (SELECT COUNT(*)::int FROM finance.journal_entries) AS journals,
        (SELECT COALESCE(SUM(debit_minor), 0)::text FROM finance.journal_lines) AS debit_sum,
        (SELECT COUNT(*)::int FROM platform.outbox_events) AS outbox_cnt,
        (SELECT COUNT(*)::int FROM notifications.email_messages) AS email_cnt
    `;
    const before = (await testDb.pool.query<Record<string, unknown>>(countsQuery)).rows[0];
    const outcome = await opsService.executeReconciliation({ triggeredBy: 'cron' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.detail.run.status).toBe('ok');
    }
    const after = (await testDb.pool.query<Record<string, unknown>>(countsQuery)).rows[0];
    expect(after).toEqual(before);
  });

  it('AC2(a): Fault — allocated off by 1 and booking seat-sum mismatch are caught', async () => {
    const depBefore = await testDb.pool.query<{ allocated: number }>(
      `SELECT allocated FROM inventory.departures WHERE id = $1`,
      [departureId],
    );
    const origAlloc = depBefore.rows[0]!.allocated;

    await testDb.pool.query(`UPDATE inventory.departures SET allocated = $1 WHERE id = $2`, [
      origAlloc + 1,
      departureId,
    ]);
    try {
      const outcome = await opsService.executeReconciliation({
        triggeredBy: 'test-fault-2a-alloc',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.detail.run.status).toBe('errors');
        const codes = outcome.detail.findings.map((f) => f.code);
        expect(codes).toContain('INVENTORY_VERIFY_ALLOCATED_MISMATCH');
        expect(codes).toContain('INVENTORY_BOOKING_SEAT_SUM_MISMATCH');
      }
    } finally {
      await testDb.pool.query(`UPDATE inventory.departures SET allocated = $1 WHERE id = $2`, [
        origAlloc,
        departureId,
      ]);
    }

    // Also test booking seats out of sync while departures.allocated == active allocations (kills Mutation a)
    await testDb.pool.query('BEGIN');
    await testDb.pool.query('ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition');
    await testDb.pool.query(`UPDATE booking.bookings SET seats = seats + 1 WHERE reference = $1`, [
      happyRef,
    ]);
    await testDb.pool.query('ALTER TABLE booking.bookings ENABLE TRIGGER trg_bookings_transition');
    await testDb.pool.query('COMMIT');
    try {
      const outcome = await opsService.executeReconciliation({
        triggeredBy: 'test-fault-2a-seats',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.detail.findings.map((f) => f.code)).toContain(
          'INVENTORY_BOOKING_SEAT_SUM_MISMATCH',
        );
      }
    } finally {
      await testDb.pool.query('BEGIN');
      await testDb.pool.query(
        'ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition',
      );
      await testDb.pool.query(
        `UPDATE booking.bookings SET seats = seats - 1 WHERE reference = $1`,
        [happyRef],
      );
      await testDb.pool.query(
        'ALTER TABLE booking.bookings ENABLE TRIGGER trg_bookings_transition',
      );
      await testDb.pool.query('COMMIT');
    }
  });

  it('AC2(b): Fault — confirmed booking without succeeded attempt is caught', async () => {
    const attemptRes = await testDb.pool.query<{ id: string }>(
      `SELECT pa.id FROM payments.payment_attempts pa
       INNER JOIN booking.bookings b ON b.id = pa.booking_id
       WHERE b.reference = $1 AND pa.status = 'succeeded'`,
      [happyRef],
    );
    const attemptId = attemptRes.rows[0]!.id;

    await testDb.pool.query('BEGIN');
    await testDb.pool.query('ALTER TABLE payments.payment_attempts DISABLE TRIGGER ALL');
    await testDb.pool.query(
      `UPDATE payments.payment_attempts SET status = 'failed' WHERE id = $1`,
      [attemptId],
    );
    await testDb.pool.query('ALTER TABLE payments.payment_attempts ENABLE TRIGGER ALL');
    await testDb.pool.query('COMMIT');
    try {
      const outcome = await opsService.executeReconciliation({ triggeredBy: 'test-fault-2b' });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.detail.run.status).toBe('errors');
        expect(outcome.detail.findings.map((f) => f.code)).toContain(
          'BOOKING_CONFIRMED_MISSING_SUCCEEDED_ATTEMPT',
        );
      }
    } finally {
      await testDb.pool.query('BEGIN');
      await testDb.pool.query('ALTER TABLE payments.payment_attempts DISABLE TRIGGER ALL');
      await testDb.pool.query(
        `UPDATE payments.payment_attempts SET status = 'succeeded' WHERE id = $1`,
        [attemptId],
      );
      await testDb.pool.query('ALTER TABLE payments.payment_attempts ENABLE TRIGGER ALL');
      await testDb.pool.query('COMMIT');
    }
  });

  it('AC2(c): Fault — mock PSP success without matching attempt is caught and emits outbox ops.reconciliation_errors', async () => {
    const orphanMockId = randomUUID();
    const orphanAttemptId = randomUUID();
    await testDb.pool.query(
      `INSERT INTO payments.mock_psp_transactions
       (id, provider_ref, attempt_id, booking_reference, amount_minor, currency, locale, return_url, status, occurred_at)
       VALUES ($1, $2, $3, $4, 500000, 'VND', 'vi', '/vi', 'succeeded', now())`,
      [orphanMockId, `mock-orphan-${orphanMockId.slice(0, 8)}`, orphanAttemptId, happyRef],
    );
    try {
      const outcome = await opsService.executeReconciliation({ triggeredBy: 'test-fault-2c' });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.detail.run.status).toBe('errors');
        expect(outcome.detail.findings.map((f) => f.code)).toContain(
          'PSP_SETTLEMENT_MISSING_ATTEMPT',
        );
        const evRows = await db
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.aggregateId, outcome.detail.run.id));
        expect(evRows.some((e) => e.eventType === 'ops.reconciliation_errors')).toBe(true);
      }
    } finally {
      await testDb.pool.query(`DELETE FROM payments.mock_psp_transactions WHERE id = $1`, [
        orphanMockId,
      ]);
    }
  });

  it('AC2(d): Fault — added/tampered ledger posting breaks ledger identity and is caught', async () => {
    const clearingRes = await testDb.pool.query<{ id: string }>(
      `SELECT id FROM finance.accounts WHERE code = 'asset:psp_clearing:mock:VND' LIMIT 1`,
    );
    const prepayRes = await testDb.pool.query<{ id: string }>(
      `SELECT id FROM finance.accounts WHERE code = 'liability:customer_prepayments:VND' LIMIT 1`,
    );
    const clearingId = clearingRes.rows[0]!.id;
    const prepayId = prepayRes.rows[0]!.id;
    const extraEntryId = randomUUID();
    const extraLine1 = randomUUID();
    const extraLine2 = randomUUID();

    await testDb.pool.query('BEGIN');
    await testDb.pool.query(
      `INSERT INTO finance.journal_entries (id, effective_date, description, source_type, source_id, entry_kind)
       VALUES ($1::uuid, current_date, 'Phantom imbalance test', 'test_fault', $2::text, 'test_fault')`,
      [extraEntryId, extraEntryId],
    );
    await testDb.pool.query(
      `INSERT INTO finance.journal_lines (id, entry_id, account_id, currency, debit_minor, credit_minor)
       VALUES
         ($1::uuid, $3::uuid, $4::uuid, 'VND', 123456, 0),
         ($2::uuid, $3::uuid, $5::uuid, 'VND', 0, 123456)`,
      [extraLine1, extraLine2, extraEntryId, clearingId, prepayId],
    );
    await testDb.pool.query('COMMIT');
    try {
      const outcome = await opsService.executeReconciliation({ triggeredBy: 'test-fault-2d' });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.detail.run.status).toBe('errors');
        const codes = outcome.detail.findings.map((f) => f.code);
        expect(codes).toContain('LEDGER_PSP_CLEARING_MISMATCH');
        expect(codes).toContain('LEDGER_CUSTOMER_PREPAYMENTS_MISMATCH');
      }
    } finally {
      await testDb.pool.query('BEGIN');
      await testDb.pool.query('ALTER TABLE finance.journal_lines DISABLE TRIGGER ALL');
      await testDb.pool.query('ALTER TABLE finance.journal_entries DISABLE TRIGGER ALL');
      await testDb.pool.query(`DELETE FROM finance.journal_lines WHERE entry_id = $1`, [
        extraEntryId,
      ]);
      await testDb.pool.query(`DELETE FROM finance.journal_entries WHERE id = $1`, [extraEntryId]);
      await testDb.pool.query('ALTER TABLE finance.journal_lines ENABLE TRIGGER ALL');
      await testDb.pool.query('ALTER TABLE finance.journal_entries ENABLE TRIGGER ALL');
      await testDb.pool.query('COMMIT');
    }
  });

  it('AC2(e): Fault — payment attempt amount differing from booking total is caught', async () => {
    const attemptRes = await testDb.pool.query<{ id: string; amount_minor: string }>(
      `SELECT pa.id, pa.amount_minor::text FROM payments.payment_attempts pa
       INNER JOIN booking.bookings b ON b.id = pa.booking_id
       WHERE b.reference = $1 AND pa.status = 'succeeded'`,
      [happyRef],
    );
    const attemptId = attemptRes.rows[0]!.id;
    const origAmount = attemptRes.rows[0]!.amount_minor;

    await testDb.pool.query('BEGIN');
    await testDb.pool.query('ALTER TABLE payments.payment_attempts DISABLE TRIGGER ALL');
    await testDb.pool.query(
      `UPDATE payments.payment_attempts SET amount_minor = $1 WHERE id = $2`,
      ['999000', attemptId],
    );
    await testDb.pool.query('ALTER TABLE payments.payment_attempts ENABLE TRIGGER ALL');
    await testDb.pool.query('COMMIT');
    try {
      const outcome = await opsService.executeReconciliation({ triggeredBy: 'test-fault-2e' });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.detail.run.status).toBe('errors');
        expect(outcome.detail.findings.map((f) => f.code)).toContain('PAYMENT_AMOUNT_MISMATCH');
      }
    } finally {
      await testDb.pool.query('BEGIN');
      await testDb.pool.query('ALTER TABLE payments.payment_attempts DISABLE TRIGGER ALL');
      await testDb.pool.query(
        `UPDATE payments.payment_attempts SET amount_minor = $1 WHERE id = $2`,
        [origAmount, attemptId],
      );
      await testDb.pool.query('ALTER TABLE payments.payment_attempts ENABLE TRIGGER ALL');
      await testDb.pool.query('COMMIT');
    }
  });

  it('AC3: Stuck states (initiated >60m, refund manual_review, overdue hold) trigger warnings with status warnings', async () => {
    // 1. Overdue hold past hold_expires_at + 5 min
    const qRes = await fetch(
      `${baseUrl}/catalog/products/${productId}/quote?departureId=${departureId}&adult=1&child=0&infant=0&locale=vi`,
    );
    const q = (await qRes.json()) as PublicQuoteResponse;
    const holdRes = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: 1, child: 0, infant: 0 },
        contact: {
          name: 'Warn Guest',
          email: 'warn@example.com',
          phone: '+84900003333',
          locale: 'vi',
        },
        expectedSnapshotHash: q.snapshotHash,
      }),
    });
    const hold = (await holdRes.json()) as HoldBookingResponseDto;
    overdueBookingId = hold.id;

    // 2. Old initiated payment attempt (> 60 min)
    const staleAttemptId = randomUUID();
    await testDb.pool.query(
      `INSERT INTO payments.payment_attempts
       (id, booking_id, provider, provider_ref, amount_minor, currency, provider_config_snapshot, status, created_at)
       VALUES ($1, $2, 'mock', $3, $4, 'VND', '{}'::jsonb, 'initiated', now() - interval '90 minutes')`,
      [staleAttemptId, hold.id, `mock-stale-${staleAttemptId.slice(0, 8)}`, q.totalAmountMinor],
    );

    // Move hold_expires_at 10 min into the past cleanly
    await testDb.pool.query('BEGIN');
    await testDb.pool.query('ALTER TABLE booking.bookings DISABLE TRIGGER trg_bookings_transition');
    await testDb.pool.query(
      `UPDATE booking.bookings SET hold_expires_at = now() - interval '10 minutes' WHERE id = $1`,
      [hold.id],
    );
    await testDb.pool.query('ALTER TABLE booking.bookings ENABLE TRIGGER trg_bookings_transition');
    await testDb.pool.query('COMMIT');

    // 3. Refund in manual_review (move one existing succeeded? Better: create booking+refund auto_fail until manual_review)
    const mrBooking = await createAndPayBooking(customerCookie, departureId, 'Manual Review Guest');
    await testDb.pool.query(
      `UPDATE payments.mock_psp_transactions SET refund_mode = 'auto_fail' WHERE provider_ref = $1`,
      [mrBooking.providerRef],
    );
    const mrCancel = await fetch(`${baseUrl}/bookings/${mrBooking.reference}/cancel`, {
      method: 'POST',
      headers: { Cookie: customerCookie, 'Idempotency-Key': nextIdemKey() },
    });
    expect(mrCancel.status).toBe(200);
    for (let i = 0; i < 3; i++) {
      await testDb.pool.query('BEGIN');
      await testDb.pool.query('ALTER TABLE payments.refunds DISABLE TRIGGER ALL');
      await testDb.pool.query(
        `UPDATE payments.refunds SET next_attempt_at = now() WHERE booking_id = $1`,
        [mrBooking.bookingId],
      );
      await testDb.pool.query('ALTER TABLE payments.refunds ENABLE TRIGGER ALL');
      await testDb.pool.query('COMMIT');
      await refundService.processDueRefunds();
    }
    const [mrRefund] = await db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, mrBooking.bookingId));
    expect(mrRefund?.status).toBe('manual_review');
    manualReviewRefundId = mrRefund!.id;

    const outcome = await opsService.executeReconciliation({ triggeredBy: 'test-ac3-warnings' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.detail.run.status).toBe('warnings');
      expect(outcome.detail.run.counts.errors).toBe(0);
      expect(outcome.detail.run.counts.warnings).toBeGreaterThanOrEqual(3);
      const codes = outcome.detail.findings.map((f) => f.code);
      expect(codes).toContain('BOOKING_OVERDUE_HOLD');
      expect(codes).toContain('PAYMENT_STUCK_INITIATED');
      expect(codes).toContain('REFUND_MANUAL_REVIEW');
    }

    // Also test GET /admin/refunds lists the manual_review refund
    const refundsRes = await fetch(`${baseUrl}/admin/refunds?status=manual_review,failed`, {
      headers: { Cookie: adminCookie },
    });
    expect(refundsRes.status).toBe(200);
    const refundsJson = (await refundsRes.json()) as { items: Array<{ id: string }> };
    expect(refundsJson.items.some((r) => r.id === manualReviewRefundId)).toBe(true);
  });

  it('AC4: Single-flight advisory lock allows 1 concurrent run and rejects the second with 409 already_running', async () => {
    const { InventoryService } = await import('../inventory/index.js');
    const inv = app.get(InventoryService);
    const origCheck = inv.runReconciliationChecks.bind(inv);

    let notifyInsideLock!: () => void;
    const insideLockPromise = new Promise<void>((res) => {
      notifyInsideLock = res;
    });
    let releaseLock!: () => void;
    const holdLockPromise = new Promise<void>((res) => {
      releaseLock = res;
    });

    let interceptedOnce = false;
    inv.runReconciliationChecks = async (asOf: Date) => {
      if (!interceptedOnce) {
        interceptedOnce = true;
        notifyInsideLock();
        await holdLockPromise;
      }
      return origCheck(asOf);
    };

    let firstPromise: Promise<Response> | undefined;
    try {
      firstPromise = fetch(`${baseUrl}/admin/reconciliation/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({ reason: 'concurrent 1' }),
      });

      await insideLockPromise;

      const secondRes = await fetch(`${baseUrl}/admin/reconciliation/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify({ reason: 'concurrent 2' }),
      });
      const secondBody = (await secondRes.json()) as {
        code?: string;
        errorCode?: string;
        status?: number;
        detail?: string;
      };
      expect(secondRes.status, JSON.stringify(secondBody)).toBe(409);
      expect(secondBody.code ?? secondBody.errorCode).toMatch(/already_running/);

      releaseLock();
      const firstRes = await firstPromise;
      expect(firstRes.status).toBe(200);
    } finally {
      releaseLock();
      inv.runReconciliationChecks = origCheck;
      await firstPromise?.catch(() => undefined);
    }
  });

  it('AC6: Every admin action creates 1 audit row in the same transaction and rollback leaves zero audit rows', async () => {
    // 1. Explicit transaction rollback check via real adminRetryRefund failure after recordAudit (kills Mutation d)
    const origEnqueue = outboxService.enqueue.bind(outboxService);
    outboxService.enqueue = () => Promise.reject(new Error('simulated outbox failure after audit'));
    try {
      const failedRetry = await adminPost(`/admin/refunds/${manualReviewRefundId}/retry`, {
        reason: 'Rollback check should leave no audit row',
      });
      expect(failedRetry.status).toBe(500);
    } finally {
      outboxService.enqueue = origEnqueue;
    }

    const orphanAudits = await db
      .select()
      .from(opsAdminAudit)
      .where(eq(opsAdminAudit.reason, 'Rollback check should leave no audit row'));
    expect(orphanAudits).toHaveLength(0);

    // 2. refund_retry succeeds after rollback check and is audited
    const retryRes = await adminPost(`/admin/refunds/${manualReviewRefundId}/retry`, {
      reason: 'PSP recovered',
    });
    expect(retryRes.status).toBe(200);
    const retryAudits = await db
      .select()
      .from(opsAdminAudit)
      .where(eq(opsAdminAudit.targetId, manualReviewRefundId));
    expect(retryAudits.filter((a) => a.action === 'refund_retry')).toHaveLength(1);
    expect(retryAudits[0]!.reason).toBe('PSP recovered');

    // 3. departure_close & departure_reopen each create 1 audit row in the same transaction (R2)
    const closeRes = await adminPost(`/admin/inventory/departures/${departureId}/close`, {
      reason: 'Maintenance',
    });
    expect(closeRes.status).toBe(200);
    const closeAudits = await db
      .select()
      .from(opsAdminAudit)
      .where(
        and(eq(opsAdminAudit.targetId, departureId), eq(opsAdminAudit.action, 'departure_close')),
      );
    expect(closeAudits).toHaveLength(1);
    expect(closeAudits[0]!.targetType).toBe('departure');
    expect(closeAudits[0]!.reason).toBe('Maintenance');

    const reopenRes = await adminPost(`/admin/inventory/departures/${departureId}/reopen`, {
      reason: 'Cleared',
    });
    expect(reopenRes.status).toBe(200);
    const reopenAudits = await db
      .select()
      .from(opsAdminAudit)
      .where(
        and(eq(opsAdminAudit.targetId, departureId), eq(opsAdminAudit.action, 'departure_reopen')),
      );
    expect(reopenAudits).toHaveLength(1);
    expect(reopenAudits[0]!.targetType).toBe('departure');
    expect(reopenAudits[0]!.reason).toBe('Cleared');

    // 3b. reconciliation_run (run-now) creates 1 audit row in the same transaction (R2)
    const runNowRes = await adminPost<ReconciliationRunDetailDto>('/admin/reconciliation/runs', {
      reason: 'AC6 run-now audit verification',
    });
    expect(runNowRes.status).toBe(200);
    const runNowAudits = await db
      .select()
      .from(opsAdminAudit)
      .where(
        and(
          eq(opsAdminAudit.targetId, runNowRes.body.run.id),
          eq(opsAdminAudit.action, 'reconciliation_run'),
        ),
      );
    expect(runNowAudits).toHaveLength(1);
    expect(runNowAudits[0]!.targetType).toBe('reconciliation_run');
    expect(runNowAudits[0]!.reason).toBe('AC6 run-now audit verification');

    // 4. departure_cancel audited + failure on already-cancelled departure
    const genExtra = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: futureUtcDateString(20),
        toDate: futureUtcDateString(20),
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['10:00'],
        capacity: 10,
        bookingCutoffMinutes: 60,
      },
    );
    const depToCancel = genExtra.body.createdIds[0]!;
    const cancelDepRes = await adminPost(`/admin/departures/${depToCancel}/cancel`, {
      reason: 'Storm warning',
    });
    expect(cancelDepRes.status).toBe(200);

    // Attempting close on cancelled departure fails -> zero departure_close audit rows for depToCancel
    const closeCancelledRes = await adminPost(`/admin/inventory/departures/${depToCancel}/close`, {
      reason: 'Should rollback',
    });
    expect(closeCancelledRes.status).toBe(422);

    const depAudits = await db
      .select()
      .from(opsAdminAudit)
      .where(eq(opsAdminAudit.targetId, depToCancel));
    expect(depAudits.map((a) => a.action)).toEqual(['departure_cancel']);
  });

  it('AC7 & AC8: Access control (401/403, operator allowed), admin:grant CLI & module boundaries', async () => {
    const adminPaths = [
      { method: 'GET', path: '/admin/dashboard' },
      { method: 'GET', path: '/admin/bookings' },
      { method: 'GET', path: `/admin/bookings/${happyRef}` },
      { method: 'GET', path: '/admin/refunds' },
      { method: 'POST', path: '/admin/reconciliation/runs' },
      { method: 'GET', path: '/admin/reconciliation/runs' },
      { method: 'GET', path: `/admin/reconciliation/runs/${randomUUID()}` },
    ];

    for (const ep of adminPaths) {
      const headers: Record<string, string> =
        ep.method === 'POST' ? { 'Idempotency-Key': nextIdemKey() } : {};
      const anonRes = await fetch(`${baseUrl}${ep.path}`, { method: ep.method, headers });
      expect(anonRes.status).toBe(401);

      const custRes = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { ...headers, Cookie: customerCookie },
      });
      expect(custRes.status).toBe(403);
    }

    // Operator role granted via admin:grant CLI helper works and writes ops.admin_audit row
    await expect(
      runAdminGrant(db, {
        email: operatorEmail,
        role: 'operator',
        appEnv: 'production',
      }),
    ).rejects.toThrow(AdminGrantProductionForbiddenError);

    const grantRes = await runAdminGrant(db, {
      email: operatorEmail,
      role: 'operator',
      actor: 'cli:test-runner',
      appEnv: 'staging',
    });
    expect(grantRes.role).toBe('operator');

    const opDash = await fetch(`${baseUrl}/admin/dashboard`, {
      headers: { Cookie: operatorCookie },
    });
    expect(opDash.status).toBe(200);

    const grantAudits = await db
      .select()
      .from(opsAdminAudit)
      .where(eq(opsAdminAudit.id, grantRes.auditId));
    expect(grantAudits).toHaveLength(1);
    expect(grantAudits[0]!.action).toBe('admin_role_grant');

    // Verify GET /admin/reconciliation/runs pagination works
    const runsListRes = await fetch(`${baseUrl}/admin/reconciliation/runs?limit=2`, {
      headers: { Cookie: operatorCookie },
    });
    expect(runsListRes.status).toBe(200);
    const runsList = (await runsListRes.json()) as ReconciliationRunListResponse;
    expect(runsList.items.length).toBeGreaterThanOrEqual(2);

    // AC8: Verify ops module never imports internal files or non-ops schemas
    const opsDir = dirname(fileURLToPath(import.meta.url));
    for (const entry of readdirSync(opsDir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) {
        continue;
      }
      const src = readFileSync(join(opsDir, entry), 'utf8');
      const relImports = src.match(/from\s+['"]\.\.\/([^'"/]+)\/[^'"]+['"]/g) ?? [];
      for (const imp of relImports) {
        if (!imp.includes('../common/') && !imp.includes('../database/')) {
          expect(imp).toMatch(/index\.js['"]$/);
        }
      }
    }
    void cancelledRef;
    void overdueBookingId;
    void customerId;
    void mockProvider;
    void opsReconciliationFindings;
    void opsReconciliationRuns;
    void createBarrier;
  });

  it('R1: Admin audit fails closed (503 + error log + tx rollback) when ADMIN_AUDIT_PORT is missing', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const isolatedMod = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        I18nModule,
        IdempotencyModule,
        IdentityModule,
        SupplyModule,
        CatalogModule,
        InventoryModule,
      ],
    }).compile();
    const isolatedApp = isolatedMod.createNestApplication({ bodyParser: false });
    configureApp(isolatedApp);
    await isolatedApp.listen(0);

    try {
      const isolatedUrl = await isolatedApp.getUrl();
      const isolatedInventory = isolatedMod.get(InventoryService);

      await expect(
        isolatedInventory.closeDeparture(departureId, 'admin-r1-test', 'R1 missing audit port'),
      ).rejects.toThrow(ServiceUnavailableException);

      await expect(
        isolatedInventory.reopenDeparture(departureId, 'admin-r1-test', 'R1 missing audit port'),
      ).rejects.toThrow(ServiceUnavailableException);

      const httpRes = await fetch(
        `${isolatedUrl}/admin/inventory/departures/${departureId}/close`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: adminCookie,
            'Idempotency-Key': nextIdemKey(),
          },
          body: JSON.stringify({ reason: 'R1 HTTP 503 check' }),
        },
      );
      expect(httpRes.status).toBe(503);

      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('ADMIN_AUDIT_PORT'))).toBe(
        true,
      );

      const [depRow] = await db
        .select({ status: inventoryDepartures.status })
        .from(inventoryDepartures)
        .where(eq(inventoryDepartures.id, departureId));
      expect(depRow?.status).toBe('open');

      const rejectedAudits = await db
        .select()
        .from(opsAdminAudit)
        .where(eq(opsAdminAudit.reason, 'R1 HTTP 503 check'));
      expect(rejectedAudits).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await isolatedApp.close();
    }
  });

  it('R3: Outbox allow-list and staging cleanup script prevent false-positive dead-letter reconciliation noise', async () => {
    expect(OUTBOX_EVENTS_WITHOUT_CONSUMERS.has('booking.payment_pending')).toBe(true);
    expect(OUTBOX_EVENTS_WITHOUT_CONSUMERS.has('payment.initiated')).toBe(true);
    expect(OUTBOX_EVENTS_WITHOUT_CONSUMERS.has('payment.succeeded')).toBe(true);
    expect(OUTBOX_EVENTS_WITHOUT_CONSUMERS.has('refund.requested')).toBe(true);
    expect(OUTBOX_EVENTS_WITHOUT_CONSUMERS.has('ops.reconciliation_errors')).toBe(true);

    await expect(cleanupDeadLetteredNoConsumerOutbox(db, { appEnv: 'production' })).rejects.toThrow(
      StagingOutboxCleanupProductionForbiddenError,
    );

    // Seed one historical dead-lettered declared no-consumer row and one real delivery failure row
    const declaredDeadRow = await db.transaction((tx) =>
      outboxService.enqueue(tx, {
        aggregateType: 'payment',
        aggregateId: `r3-declared-${randomUUID()}`,
        eventType: 'payment.initiated',
        payload: { test: true },
      }),
    );
    await db
      .update(outboxEvents)
      .set({
        attempts: 10,
        lastError: 'No handler registered for outbox event type "payment.initiated"',
        deadLetteredAt: new Date(),
      })
      .where(eq(outboxEvents.id, declaredDeadRow.id));

    const realFailureRow = await db.transaction((tx) =>
      outboxService.enqueue(tx, {
        aggregateType: 'booking',
        aggregateId: `r3-real-${randomUUID()}`,
        eventType: 'booking.confirmed',
        payload: { test: true },
      }),
    );
    await db
      .update(outboxEvents)
      .set({
        attempts: 10,
        lastError: 'SMTP transport failed permanently',
        deadLetteredAt: new Date(),
      })
      .where(eq(outboxEvents.id, realFailureRow.id));

    const cleanupRes = await cleanupDeadLetteredNoConsumerOutbox(db, {
      appEnv: 'staging',
      includeLegacyUnhandled: true,
    });
    expect(cleanupRes.declaredUpdated).toBeGreaterThanOrEqual(1);

    const [cleanedDeclared] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, declaredDeadRow.id));
    expect(cleanedDeclared?.outcome).toBe('no_consumer');
    expect(cleanedDeclared?.deadLetteredAt).toBeNull();
    expect(cleanedDeclared?.publishedAt).not.toBeNull();

    const [untouchedReal] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, realFailureRow.id));
    expect(untouchedReal?.deadLetteredAt).not.toBeNull();

    const findings = await outboxService.runReconciliationChecks(new Date(Date.now() + 5_000));
    expect(findings.map((f) => f.entityId)).not.toContain(declaredDeadRow.id);
    expect(findings.map((f) => f.entityId)).toContain(realFailureRow.id);

    // Clean synthetic real failure row so subsequent reconciliation runs stay clean
    await db.delete(outboxEvents).where(eq(outboxEvents.id, realFailureRow.id));
  });
});
