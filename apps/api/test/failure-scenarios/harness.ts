import { Writable } from 'node:stream';
import {
  bookingBookings,
  type DatabaseClient,
  eq,
  grantRoleByEmail,
  identityUsers,
  seedReferenceData,
} from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { expect } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { FaultInjectionModule, FaultInjector } from '../../src/common/fault-injection/index.js';
import { createPinoLogger } from '../../src/common/observability/logger.js';
import { DRIZZLE_DB } from '../../src/database/database.module.js';
import { BookingService, type HoldBookingResponseDto } from '../../src/modules/booking/index.js';
import type { AdminCatalogProductDto } from '../../src/modules/catalog/index.js';
import type { GenerateDeparturesResult } from '../../src/modules/inventory/index.js';
import { InboxService, OutboxService } from '../../src/modules/messaging/index.js';
import {
  EMAIL_TRANSPORT,
  LogEmailTransport,
  NotificationsService,
} from '../../src/modules/notifications/index.js';
import type { ReconciliationRunDetailDto } from '../../src/modules/ops/index.js';
import {
  type InitiateCheckoutResponseDto,
  MockPaymentProvider,
  PaymentsService,
  RefundService,
} from '../../src/modules/payments/index.js';
import type { PublicQuoteResponse } from '../../src/modules/pricing/index.js';
import type { SupplierRecord } from '../../src/modules/supply/index.js';
import { createTestDatabase, type TestDbInstance } from '../test-db.js';

const DEFAULT_AUTH_SECRET = 'p2-11-failure-suite-auth-secret-at-least-32-chars';
const DEFAULT_MOCK_PSP_SECRET = 'p2-11-failure-suite-mock-psp-secret-at-least-32';

export interface SignedInActor {
  readonly cookie: string;
  readonly userId: string;
  readonly email: string;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export function extractCookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

export function futureUtcDateString(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

export interface FailureScenarioHarness {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly db: DatabaseClient;
  readonly testDb: TestDbInstance;
  readonly faultInjector: FaultInjector;
  readonly bookingService: BookingService;
  readonly paymentsService: PaymentsService;
  readonly refundService: RefundService;
  readonly mockProvider: MockPaymentProvider;
  readonly inboxService: InboxService;
  readonly outboxService: OutboxService;
  readonly notificationsService: NotificationsService;
  readonly emailTransport: LogEmailTransport;
  readonly adminCookie: string;
  readonly adminUserId: string;
  readonly productId: string;
  nextIdemKey: (prefix?: string) => string;
  adminPost: <T = unknown>(
    path: string,
    payload?: unknown,
    idemKey?: string,
  ) => Promise<HttpResponse<T>>;
  adminPut: <T = unknown>(path: string, payload?: unknown) => Promise<HttpResponse<T>>;
  signUpVerifiedCustomer: (email: string, name?: string) => Promise<SignedInActor>;
  createVerifiedAdmin: (email: string, name?: string) => Promise<SignedInActor>;
  generateDeparture: (options?: {
    readonly daysAhead?: number;
    readonly capacity?: number;
    readonly localTime?: string;
  }) => Promise<string>;
  getQuote: (departureId: string, adult?: number, locale?: string) => Promise<PublicQuoteResponse>;
  holdBooking: (
    cookie: string,
    departureId: string,
    expectedSnapshotHash: string,
    options?: {
      readonly idemKey?: string;
      readonly adult?: number;
      readonly contactName?: string;
      readonly contactEmail?: string;
      readonly locale?: string;
    },
  ) => Promise<HttpResponse<HoldBookingResponseDto & { errorCode?: string; code?: string }>>;
  checkoutBooking: (
    cookie: string,
    reference: string,
    idemKey?: string,
  ) => Promise<HttpResponse<InitiateCheckoutResponseDto & { errorCode?: string; code?: string }>>;
  submitMockPspAction: (
    providerRef: string,
    action?: 'success' | 'fail' | 'cancel' | 'duplicate' | 'delayed_3m' | 'wrong_amount',
  ) => Promise<number>;
  cancelBookingHttp: (
    cookie: string,
    reference: string,
    idemKey?: string,
  ) => Promise<HttpResponse<Record<string, unknown>>>;
  rejectBookingHttp: (
    reference: string,
    reason: string,
    options?: { readonly cookie?: string; readonly idemKey?: string },
  ) => Promise<HttpResponse<Record<string, unknown>>>;
  drainAllWorkers: () => Promise<void>;
  assertReconciliationOk: (reason?: string) => Promise<ReconciliationRunDetailDto>;
  teardown: () => Promise<void>;
}

export async function bootFailureScenarioHarness(options?: {
  readonly faultInjection?: boolean;
}): Promise<FailureScenarioHarness> {
  const prevEnv: Record<string, string | undefined> = {
    DATABASE_URL: process.env['DATABASE_URL'],
    NODE_ENV: process.env['NODE_ENV'],
    APP_ENV: process.env['APP_ENV'],
    FAULT_INJECTION: process.env['FAULT_INJECTION'],
    BETTER_AUTH_SECRET: process.env['BETTER_AUTH_SECRET'],
    AUTH_TRUSTED_ORIGINS: process.env['AUTH_TRUSTED_ORIGINS'],
    TRUSTED_PROXY_CIDRS: process.env['TRUSTED_PROXY_CIDRS'],
    PG_BOSS_DISABLED: process.env['PG_BOSS_DISABLED'],
    MOCK_PAYMENT_ENABLED: process.env['MOCK_PAYMENT_ENABLED'],
    MOCK_PSP_SECRET: process.env['MOCK_PSP_SECRET'],
    MOCK_PSP_WEBHOOK_SECRET: process.env['MOCK_PSP_WEBHOOK_SECRET'],
    MOCK_PSP_CALLBACK_URL: process.env['MOCK_PSP_CALLBACK_URL'],
    MOCK_PSP_REFUND_MODE: process.env['MOCK_PSP_REFUND_MODE'],
  };

  const testDb = await createTestDatabase();
  await seedReferenceData(testDb.db);

  process.env['NODE_ENV'] = 'test';
  process.env['APP_ENV'] = 'test';
  process.env['DATABASE_URL'] = testDb.testUrl;
  process.env['FAULT_INJECTION'] = options?.faultInjection ? '1' : '0';
  process.env['BETTER_AUTH_SECRET'] = DEFAULT_AUTH_SECRET;
  process.env['AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3000,http://127.0.0.1';
  process.env['TRUSTED_PROXY_CIDRS'] = '127.0.0.1/32,::1/128';
  process.env['PG_BOSS_DISABLED'] = 'true';
  process.env['MOCK_PAYMENT_ENABLED'] = 'true';
  process.env['MOCK_PSP_SECRET'] = DEFAULT_MOCK_PSP_SECRET;
  process.env['MOCK_PSP_WEBHOOK_SECRET'] = DEFAULT_MOCK_PSP_SECRET;
  delete process.env['MOCK_PSP_REFUND_MODE'];

  const emailTransport = new LogEmailTransport();
  const pinoLogger = createPinoLogger({
    destination: new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
    level: 'silent',
  });

  const mod: TestingModule = await Test.createTestingModule({
    imports: [AppModule, FaultInjectionModule],
  })
    .overrideProvider(EMAIL_TRANSPORT)
    .useValue(emailTransport)
    .compile();

  const app = mod.createNestApplication({ bodyParser: false });
  configureApp(app, { logger: pinoLogger });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  process.env['MOCK_PSP_CALLBACK_URL'] = `${baseUrl}/webhooks/mock-psp`;

  const db = app.get<DatabaseClient>(DRIZZLE_DB);
  const faultInjector = app.get(FaultInjector);
  const bookingService = app.get(BookingService);
  const paymentsService = app.get(PaymentsService);
  const refundService = app.get(RefundService);
  const mockProvider = app.get(MockPaymentProvider);
  const inboxService = app.get(InboxService);
  const outboxService = app.get(OutboxService);
  const notificationsService = app.get(NotificationsService);

  let idemSeq = 0;
  let ipSeq = 1;
  let departureOffset = 10;

  const nextIdemKey = (prefix = 'fs-key'): string => `${prefix}-${++idemSeq}-${Date.now()}`;
  const nextIp = (): string => {
    const idx = ipSeq++;
    const third = Math.floor(idx / 250);
    const fourth = (idx % 250) + 1;
    return `10.111.${third}.${fourth}`;
  };

  async function signUpVerifiedCustomer(
    email: string,
    name = 'FS Customer',
  ): Promise<SignedInActor> {
    const forwardedIp = nextIp();
    const password = 'FailureSuitePass123!';
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
    const signUpBody = (await signUpRes.json()) as { user?: { id: string } };
    const userId = signUpBody.user!.id;

    await db.update(identityUsers).set({ emailVerified: true }).where(eq(identityUsers.id, userId));

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

    return {
      cookie: extractCookieHeader(signInRes),
      userId,
      email,
    };
  }

  async function createVerifiedAdmin(email: string, name = 'FS Admin'): Promise<SignedInActor> {
    const actor = await signUpVerifiedCustomer(email, name);
    await grantRoleByEmail(db, email, 'admin');
    const signInRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ email, password: 'FailureSuitePass123!' }),
    });
    expect(signInRes.status).toBe(200);
    return {
      ...actor,
      cookie: extractCookieHeader(signInRes),
    };
  }

  const admin = await createVerifiedAdmin('fs-admin@example.com', 'FS Admin');
  const adminCookie = admin.cookie;

  async function adminPost<T = unknown>(
    path: string,
    payload?: unknown,
    idemKey?: string,
  ): Promise<HttpResponse<T>> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': idemKey ?? nextIdemKey('admin'),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body, headers: res.headers };
  }

  async function adminPut<T = unknown>(path: string, payload?: unknown): Promise<HttpResponse<T>> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': nextIdemKey('admin-put'),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body, headers: res.headers };
  }

  // Seed default supplier + tour + price list + cancellation policy
  const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
    name: 'Phu Quoc Failure Suite Demo (Demo)',
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
  const productId = prod.body.id;

  const putVi = await adminPut(`/admin/products/${productId}/translations/vi`, {
    title: 'Tour Phú Quốc Failure Suite',
    slug: `tour-pq-fs-${Date.now()}`,
    summary: 'Tóm tắt tour kiểm thử kịch bản lỗi',
    description: 'Mô tả tour kiểm thử',
  });
  expect(putVi.status, JSON.stringify(putVi.body)).toBe(200);
  const putEn = await adminPut(`/admin/products/${productId}/translations/en`, {
    title: 'Phu Quoc Failure Suite Tour',
    slug: `pq-fs-tour-${Date.now()}`,
    summary: 'Failure scenario tour summary',
    description: 'Failure scenario tour description',
  });
  expect(putEn.status, JSON.stringify(putEn.body)).toBe(200);
  const pubRes = await adminPost(`/admin/products/${productId}/publish`);
  expect(pubRes.status, JSON.stringify(pubRes.body)).toBe(200);

  const plRes = await adminPost(`/admin/pricing/products/${productId}/price-lists`, {
    currency: 'VND',
    validFrom: '2026-01-01',
    items: [
      { paxType: 'adult', amountMinor: '1000000', minAge: 10, occupiesSeat: true },
      { paxType: 'child', amountMinor: '700000', minAge: 5, maxAge: 9, occupiesSeat: true },
      { paxType: 'infant', amountMinor: '0', minAge: 0, maxAge: 4, occupiesSeat: false },
    ],
  });
  expect(plRes.status, JSON.stringify(plRes.body)).toBe(201);
  const polRes = await adminPost(`/admin/pricing/products/${productId}/cancellation-policies`, {
    rules: [
      { hoursBeforeStart: 24, refundPercent: 100 },
      { hoursBeforeStart: 0, refundPercent: 0 },
    ],
  });
  expect(polRes.status, JSON.stringify(polRes.body)).toBe(201);

  async function generateDeparture(depOpts?: {
    readonly daysAhead?: number;
    readonly capacity?: number;
    readonly localTime?: string;
  }): Promise<string> {
    const day = depOpts?.daysAhead ?? ++departureOffset;
    const dateStr = futureUtcDateString(day);
    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: dateStr,
        toDate: dateStr,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: [depOpts?.localTime ?? '09:00'],
        capacity: depOpts?.capacity ?? 30,
        bookingCutoffMinutes: 60,
      },
    );
    expect(gen.status).toBe(200);
    return gen.body.createdIds[0]!;
  }

  async function getQuote(
    departureId: string,
    adult = 1,
    locale = 'vi',
  ): Promise<PublicQuoteResponse> {
    const res = await fetch(
      `${baseUrl}/catalog/products/${productId}/quote?departureId=${departureId}&adult=${adult}&child=0&infant=0&locale=${locale}`,
    );
    const body = (await res.json()) as PublicQuoteResponse;
    expect(res.status, JSON.stringify({ url: res.url, body })).toBe(200);
    return body;
  }

  async function holdBooking(
    cookie: string,
    departureId: string,
    expectedSnapshotHash: string,
    holdOpts?: {
      readonly idemKey?: string;
      readonly adult?: number;
      readonly contactName?: string;
      readonly contactEmail?: string;
      readonly locale?: string;
    },
  ): Promise<HttpResponse<HoldBookingResponseDto & { errorCode?: string; code?: string }>> {
    const res = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': holdOpts?.idemKey ?? nextIdemKey('hold'),
      },
      body: JSON.stringify({
        departureId,
        pax: { adult: holdOpts?.adult ?? 1, child: 0, infant: 0 },
        contact: {
          name: holdOpts?.contactName ?? 'Khach Hang Test',
          email: holdOpts?.contactEmail ?? 'khach@example.com',
          phone: '+84901234567',
          locale: holdOpts?.locale ?? 'vi',
        },
        expectedSnapshotHash,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as HoldBookingResponseDto & {
      errorCode?: string;
      code?: string;
    };
    return { status: res.status, body, headers: res.headers };
  }

  async function checkoutBooking(
    cookie: string,
    reference: string,
    idemKey?: string,
  ): Promise<HttpResponse<InitiateCheckoutResponseDto & { errorCode?: string; code?: string }>> {
    const res = await fetch(`${baseUrl}/bookings/${reference}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': idemKey ?? nextIdemKey('checkout'),
      },
      body: JSON.stringify({ provider: 'mock' }),
    });
    const body = (await res.json().catch(() => ({}))) as InitiateCheckoutResponseDto & {
      errorCode?: string;
      code?: string;
    };
    return { status: res.status, body, headers: res.headers };
  }

  async function submitMockPspAction(
    providerRef: string,
    action: 'success' | 'fail' | 'cancel' | 'duplicate' | 'delayed_3m' | 'wrong_amount' = 'success',
  ): Promise<number> {
    const res = await fetch(`${baseUrl}/mock-psp/checkout/${providerRef}/action`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    return res.status;
  }

  async function cancelBookingHttp(
    cookie: string,
    reference: string,
    idemKey?: string,
  ): Promise<HttpResponse<Record<string, unknown>>> {
    const res = await fetch(`${baseUrl}/bookings/${reference}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': idemKey ?? nextIdemKey('cancel'),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body, headers: res.headers };
  }

  async function rejectBookingHttp(
    reference: string,
    reason: string,
    rejectOpts?: { readonly cookie?: string; readonly idemKey?: string },
  ): Promise<HttpResponse<Record<string, unknown>>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': rejectOpts?.idemKey ?? nextIdemKey('reject'),
    };
    if (rejectOpts?.cookie !== undefined) {
      if (rejectOpts.cookie.length > 0) {
        headers['Cookie'] = rejectOpts.cookie;
      }
    } else {
      headers['Cookie'] = adminCookie;
    }
    const res = await fetch(`${baseUrl}/admin/bookings/${reference}/reject`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body, headers: res.headers };
  }

  async function drainAllWorkers(): Promise<void> {
    for (let pass = 0; pass < 10; pass++) {
      let didWork = false;
      while ((await inboxService.relayBatch({ baseBackoffMs: 0 })) > 0) {
        didWork = true;
      }
      while ((await outboxService.relayBatch({ baseBackoffMs: 0 })) > 0) {
        didWork = true;
      }
      const refundRes = await refundService.processDueRefunds({ staleProcessingSeconds: 0 });
      if (refundRes.processedCount > 0) {
        didWork = true;
        // Deliver any newly created pending mock refunds synchronously in test mode
        const [pendingMockRefunds] = await Promise.all([
          db.execute<{ provider_refund_ref: string }>(
            `SELECT provider_refund_ref FROM payments.mock_psp_refunds WHERE status = 'succeeded' OR status = 'pending'`,
          ),
        ]);
        for (const r of pendingMockRefunds.rows) {
          await mockProvider.deliverPendingRefundCallback(
            r.provider_refund_ref,
            `${baseUrl}/webhooks/mock-psp`,
          );
        }
      }
      while ((await inboxService.relayBatch({ baseBackoffMs: 0 })) > 0) {
        didWork = true;
      }
      while ((await outboxService.relayBatch({ baseBackoffMs: 0 })) > 0) {
        didWork = true;
      }
      const emailRes = await notificationsService.processDueEmails();
      if (emailRes.processedCount > 0) {
        didWork = true;
      }
      if (!didWork) {
        break;
      }
    }
  }

  async function assertReconciliationOk(
    reason = 'failure-scenario-oracle',
  ): Promise<ReconciliationRunDetailDto> {
    const res = await adminPost<ReconciliationRunDetailDto>('/admin/reconciliation/runs', {
      reason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.findings).toEqual([]);
    expect(res.body.run.counts.errors).toBe(0);
    expect(res.body.run.counts.warnings).toBe(0);
    expect(res.body.run.status).toBe('ok');
    return res.body;
  }

  async function teardown(): Promise<void> {
    faultInjector.disarm();
    await app.close().catch(() => undefined);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    await testDb.teardown();
  }

  return {
    app,
    baseUrl,
    db,
    testDb,
    faultInjector,
    bookingService,
    paymentsService,
    refundService,
    mockProvider,
    inboxService,
    outboxService,
    notificationsService,
    emailTransport,
    adminCookie,
    adminUserId: admin.userId,
    productId,
    nextIdemKey,
    adminPost,
    adminPut,
    signUpVerifiedCustomer,
    createVerifiedAdmin,
    generateDeparture,
    getQuote,
    holdBooking,
    checkoutBooking,
    submitMockPspAction,
    cancelBookingHttp,
    rejectBookingHttp,
    drainAllWorkers,
    assertReconciliationOk,
    teardown,
  };
}

export async function findBookingRow(db: DatabaseClient, reference: string) {
  const [row] = await db
    .select()
    .from(bookingBookings)
    .where(eq(bookingBookings.reference, reference))
    .limit(1);
  return row;
}
