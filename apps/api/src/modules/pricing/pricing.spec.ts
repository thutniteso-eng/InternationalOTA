import { randomUUID } from 'node:crypto';
import {
  applyRuntimeRoleGrants,
  type DatabaseClient,
  grantRoleByEmail,
  seedReferenceData,
} from '@internationalota/db';
import { type INestApplication, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { I18nModule } from '../../common/i18n/i18n.module.js';
import { DatabaseModule, DRIZZLE_DB } from '../../database/database.module.js';
import {
  type AdminCatalogProductDto,
  CatalogModule,
  CatalogService,
  type PublicCatalogProductDetail,
} from '../catalog/index.js';
import { IdempotencyModule } from '../idempotency/index.js';
import { IdentityModule } from '../identity/index.js';
import { type GenerateDeparturesResult, InventoryService } from '../inventory/index.js';
import { type SupplierRecord, SupplyModule } from '../supply/index.js';
import { computeRefund, isSameQuote } from './pricing.refund.js';
import { PricingService } from './pricing.service.js';
import type {
  AdminCancellationPolicyDto,
  AdminPriceListDto,
  CancellationRule,
  PublicQuoteResponse,
} from './pricing.types.js';

const TEST_AUTH_SECRET = 'p2-03-pricing-test-secret-at-least-32-characters';

function extractCookieHeader(res: Response): string {
  const setCookies = res.headers.getSetCookie();
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function futureUtcDateString(daysAhead: number): string {
  const ms = Date.now() + daysAhead * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

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

describe('Pricing & Cancellation Policy integration tests (P2-03)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let pricingService: PricingService;
  let inventoryService: InventoryService;
  let catalogService: CatalogService;

  let adminCookie: string;
  let customerCookie: string;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousTrustedOrigins: string | undefined;
  let previousTrustedProxyCidrs: string | undefined;
  let previousBossDisabled: string | undefined;

  let idemSeq = 0;
  const nextIdemKey = () => `p2-03-key-${++idemSeq}`;

  async function signUpAndSignIn(
    email: string,
    password: string,
    name: string,
    forwardedIp: string,
    grantAdmin = false,
  ): Promise<string> {
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
    return extractCookieHeader(signInRes);
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

  async function adminPatch<T>(
    path: string,
    body: unknown,
    key = nextIdemKey(),
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function createPublishedTour(options: {
    namePrefix: string;
    slugSuffix: string;
    publish?: boolean;
  }): Promise<{ supplierId: string; productId: string; viSlug: string; enSlug: string }> {
    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: `${options.namePrefix} Supplier`,
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

    const viSlug = `tour-${options.slugSuffix}`;
    const enSlug = `en-tour-${options.slugSuffix}`;

    if (options.publish !== false) {
      await adminPut(`/admin/products/${prod.body.id}/translations/vi`, {
        title: `Tour ${options.namePrefix}`,
        slug: viSlug,
        summary: `Tóm tắt ${options.namePrefix}`,
        description: `Chi tiết ${options.namePrefix}`,
      });
      await adminPut(`/admin/products/${prod.body.id}/translations/en`, {
        title: `${options.namePrefix} Tour`,
        slug: enSlug,
        summary: `Summary ${options.namePrefix}`,
        description: `Details ${options.namePrefix}`,
      });
      const pub = await adminPost(`/admin/products/${prod.body.id}/publish`);
      expect(pub.status).toBe(200);
    }

    return { supplierId: sup.body.id, productId: prod.body.id, viSlug, enSlug };
  }

  async function generateDeparture(productId: string, localDate: string): Promise<string> {
    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: localDate,
        toDate: localDate,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['08:00'],
        capacity: 20,
      },
    );
    expect(gen.status).toBe(200);
    return gen.body.createdIds[0]!;
  }

  const standardRules: readonly CancellationRule[] = [
    { hoursBeforeStart: 48, refundPercent: 100 },
    { hoursBeforeStart: 24, refundPercent: 50 },
    { hoursBeforeStart: 0, refundPercent: 0 },
  ];

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
    db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
    pricingService = moduleFixture.get(PricingService);
    inventoryService = moduleFixture.get(InventoryService);
    catalogService = moduleFixture.get(CatalogService);

    adminCookie = await signUpAndSignIn(
      'pricing-admin@example.com',
      'StrongPass123!',
      'Pricing Admin',
      '10.20.0.1',
      true,
    );
    customerCookie = await signUpAndSignIn(
      'pricing-customer@example.com',
      'StrongPass123!',
      'Pricing Customer',
      '10.20.0.2',
      false,
    );
  });

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
  }, 30_000);

  it('AC1: exact bigint arithmetic for VND pax mix 2/1/1 (seats=3) and USD 12345x3', async () => {
    const vndTour = await createPublishedTour({
      namePrefix: 'AC1 VND',
      slugSuffix: 'ac1-vnd',
    });
    const depVnd = await generateDeparture(vndTour.productId, '2027-06-15');

    await adminPost<AdminCancellationPolicyDto>(
      `/admin/pricing/products/${vndTour.productId}/cancellation-policies`,
      { rules: standardRules },
    );
    const vndList = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${vndTour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-01-01',
        validTo: '2027-12-31',
        items: [
          { paxType: 'adult', amountMinor: '950000', minAge: 10, maxAge: null, occupiesSeat: true },
          { paxType: 'child', amountMinor: '650000', minAge: 5, maxAge: 9, occupiesSeat: true },
          { paxType: 'infant', amountMinor: '0', minAge: 0, maxAge: 4, occupiesSeat: false },
        ],
      },
    );
    expect(vndList.status).toBe(201);

    const vndQuote = await pricingService.quote({
      departureId: depVnd,
      pax: { adult: 2, child: 1, infant: 1 },
    });
    expect(vndQuote.ok).toBe(true);
    if (vndQuote.ok) {
      expect(vndQuote.snapshot.currency).toBe('VND');
      expect(vndQuote.snapshot.totalAmountMinor).toBe('2550000');
      expect(vndQuote.snapshot.seats).toBe(3);
      expect(vndQuote.snapshot.lines).toEqual([
        { paxType: 'adult', quantity: 2, unitAmountMinor: '950000', lineAmountMinor: '1900000' },
        { paxType: 'child', quantity: 1, unitAmountMinor: '650000', lineAmountMinor: '650000' },
        { paxType: 'infant', quantity: 1, unitAmountMinor: '0', lineAmountMinor: '0' },
      ]);
    }

    // USD (exponent 2): 12345 * 3 = 37035
    const usdTour = await createPublishedTour({
      namePrefix: 'AC1 USD',
      slugSuffix: 'ac1-usd',
    });
    const depUsd = await generateDeparture(usdTour.productId, '2027-06-15');
    await adminPost(`/admin/pricing/products/${usdTour.productId}/cancellation-policies`, {
      rules: standardRules,
    });
    await adminPost(`/admin/pricing/products/${usdTour.productId}/price-lists`, {
      currency: 'USD',
      validFrom: '2027-01-01',
      items: [
        { paxType: 'adult', amountMinor: '12345', minAge: 12, maxAge: null, occupiesSeat: true },
      ],
    });
    const usdQuote = await pricingService.quote({
      departureId: depUsd,
      pax: { adult: 3 },
    });
    expect(usdQuote.ok).toBe(true);
    if (usdQuote.ok) {
      expect(usdQuote.snapshot.currency).toBe('USD');
      expect(usdQuote.snapshot.totalAmountMinor).toBe('37035');
      expect(usdQuote.snapshot.seats).toBe(3);
    }
  });

  it('AC2: date-scoped version resolution picks highest matching version and updates snapshotHash / isSameQuote', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'AC2 Versioning',
      slugSuffix: 'ac2-versioning',
    });
    const dep10 = await generateDeparture(tour.productId, '2027-12-10');
    const dep24 = await generateDeparture(tour.productId, '2027-12-24');

    await adminPost(`/admin/pricing/products/${tour.productId}/cancellation-policies`, {
      rules: standardRules,
    });

    const v1 = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-12-01',
        validTo: '2027-12-31',
        items: [{ paxType: 'adult', amountMinor: '900000', minAge: 10, occupiesSeat: true }],
      },
    );
    expect(v1.body.version).toBe(1);

    const v2 = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-12-20',
        validTo: '2027-12-31',
        items: [{ paxType: 'adult', amountMinor: '1100000', minAge: 10, occupiesSeat: true }],
      },
    );
    expect(v2.body.version).toBe(2);

    const q10 = await pricingService.quote({ departureId: dep10, pax: { adult: 1 } });
    const q24BeforeV3 = await pricingService.quote({ departureId: dep24, pax: { adult: 1 } });
    const q24Repeat = await pricingService.quote({ departureId: dep24, pax: { adult: 1 } });

    expect(q10.ok && q10.snapshot.priceListVersion).toBe(1);
    expect(q10.ok && q10.snapshot.totalAmountMinor).toBe('900000');
    expect(q24BeforeV3.ok && q24BeforeV3.snapshot.priceListVersion).toBe(2);
    expect(q24BeforeV3.ok && q24BeforeV3.snapshot.totalAmountMinor).toBe('1100000');
    if (q24BeforeV3.ok && q24Repeat.ok) {
      expect(isSameQuote(q24BeforeV3.snapshot, q24Repeat.snapshot)).toBe(true);
    }

    // Add v3 covering Dec 20..31 -> snapshotHash must change and isSameQuote must return false
    const v3 = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-12-20',
        validTo: '2027-12-31',
        items: [{ paxType: 'adult', amountMinor: '1250000', minAge: 10, occupiesSeat: true }],
      },
    );
    expect(v3.body.version).toBe(3);

    const q24AfterV3 = await pricingService.quote({ departureId: dep24, pax: { adult: 1 } });
    expect(q24AfterV3.ok && q24AfterV3.snapshot.priceListVersion).toBe(3);
    if (q24BeforeV3.ok && q24AfterV3.ok) {
      expect(isSameQuote(q24BeforeV3.snapshot, q24AfterV3.snapshot)).toBe(false);
    }
  });

  it('AC3: immutability triggers block UPDATE/DELETE/TRUNCATE on all 3 pricing tables and runtime role lacks UPDATE/DELETE', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'AC3 Immutable',
      slugSuffix: 'ac3-immutable',
    });
    const policyRes = await adminPost<AdminCancellationPolicyDto>(
      `/admin/pricing/products/${tour.productId}/cancellation-policies`,
      { rules: standardRules },
    );
    const listRes = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-01-01',
        items: [{ paxType: 'adult', amountMinor: '500000', minAge: 10, occupiesSeat: true }],
      },
    );

    const dmlQueries = [
      {
        sql: 'UPDATE pricing.price_lists SET valid_from = valid_from + 1 WHERE id = $1::uuid',
        params: [listRes.body.id],
      },
      { sql: 'DELETE FROM pricing.price_lists WHERE id = $1::uuid', params: [listRes.body.id] },
      { sql: 'TRUNCATE pricing.price_lists CASCADE', params: [] },
      {
        sql: 'UPDATE pricing.price_list_items SET amount_minor = 1 WHERE price_list_id = $1::uuid',
        params: [listRes.body.id],
      },
      {
        sql: 'DELETE FROM pricing.price_list_items WHERE price_list_id = $1::uuid',
        params: [listRes.body.id],
      },
      { sql: 'TRUNCATE pricing.price_list_items CASCADE', params: [] },
      {
        sql: 'UPDATE pricing.cancellation_policies SET weather_clause = $2 WHERE id = $1::uuid',
        params: [policyRes.body.id, 'mutated'],
      },
      {
        sql: 'DELETE FROM pricing.cancellation_policies WHERE id = $1::uuid',
        params: [policyRes.body.id],
      },
      { sql: 'TRUNCATE pricing.cancellation_policies CASCADE', params: [] },
    ];

    for (const q of dmlQueries) {
      let pgCode: string | undefined;
      try {
        await testDb.pool.query(q.sql, q.params);
      } catch (err: unknown) {
        pgCode =
          typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
      }
      expect(pgCode).toBe('23001');
    }

    // Verify applyRuntimeRoleGrants grants only SELECT, INSERT on pricing tables (no UPDATE/DELETE/TRUNCATE)
    const testRole = `ota_p203_ro_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
    await testDb.pool.query(`CREATE ROLE ${testRole}`);
    try {
      await applyRuntimeRoleGrants(testDb.db, testRole);
      const grantsRes = await testDb.pool.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'pricing'
         ORDER BY table_name, privilege_type`,
        [testRole],
      );

      for (const table of ['price_lists', 'price_list_items', 'cancellation_policies']) {
        const privs = grantsRes.rows
          .filter((r) => r.table_name === table)
          .map((r) => r.privilege_type);
        expect(privs).toContain('SELECT');
        expect(privs).toContain('INSERT');
        expect(privs).not.toContain('UPDATE');
        expect(privs).not.toContain('DELETE');
        expect(privs).not.toContain('TRUNCATE');
      }
    } finally {
      await testDb.pool.query(`DROP OWNED BY ${testRole}; DROP ROLE IF EXISTS ${testRole};`);
    }
  });

  it('AC4: currency lock rejects mixed-currency version via API (422) and raw SQL trigger (23514), plus overlapping age bands (422)', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'AC4 Currency Lock',
      slugSuffix: 'ac4-currency-lock',
    });

    const v1 = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-01-01',
        items: [{ paxType: 'adult', amountMinor: '800000', minAge: 10, occupiesSeat: true }],
      },
    );
    expect(v1.status).toBe(201);

    const v2Mixed = await adminPost<Record<string, unknown>>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'USD',
        validFrom: '2027-02-01',
        items: [{ paxType: 'adult', amountMinor: '5000', minAge: 10, occupiesSeat: true }],
      },
    );
    expect(v2Mixed.status).toBe(422);
    expect(v2Mixed.body['i18nKey']).toBe('pricing.priceList.currencyMismatch');

    let pgCode: string | undefined;
    try {
      await testDb.pool.query(
        `INSERT INTO pricing.price_lists (id, product_id, version, currency, valid_from, created_by)
         VALUES (gen_random_uuid(), $1::uuid, 2, 'USD', '2027-02-01', 'raw-sql')`,
        [tour.productId],
      );
    } catch (err: unknown) {
      pgCode =
        typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
    }
    expect(pgCode).toBe('23514');

    // Overlapping age bands rejected with 422
    const overlapping = await adminPost<Record<string, unknown>>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-02-01',
        items: [
          { paxType: 'adult', amountMinor: '800000', minAge: 10, occupiesSeat: true },
          { paxType: 'child', amountMinor: '500000', minAge: 5, maxAge: 10, occupiesSeat: true },
        ],
      },
    );
    expect(overlapping.status).toBe(422);
    expect(overlapping.body['i18nKey']).toBe('pricing.priceList.overlappingAgeBands');
  });

  it('AC5: cancellation policy validation rejects non-monotonic, missing 0h, >100%, unsorted, and >10 rules with 422 i18nKey', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'AC5 Policy Validation',
      slugSuffix: 'ac5-policy-val',
    });

    const cases: Array<{ rules: CancellationRule[]; expectedKey: string }> = [
      {
        rules: [
          { hoursBeforeStart: 48, refundPercent: 50 },
          { hoursBeforeStart: 24, refundPercent: 100 },
          { hoursBeforeStart: 0, refundPercent: 0 },
        ],
        expectedKey: 'pricing.policy.nonMonotonicRefund',
      },
      {
        rules: [{ hoursBeforeStart: 24, refundPercent: 50 }],
        expectedKey: 'pricing.policy.missingZeroHourRule',
      },
      {
        rules: [{ hoursBeforeStart: 0, refundPercent: 101 }],
        expectedKey: 'pricing.policy.invalidRuleValues',
      },
      {
        rules: [
          { hoursBeforeStart: 24, refundPercent: 50 },
          { hoursBeforeStart: 48, refundPercent: 100 },
          { hoursBeforeStart: 0, refundPercent: 0 },
        ],
        expectedKey: 'pricing.policy.unsortedRules',
      },
      {
        rules: Array.from({ length: 11 }, (_, idx) => ({
          hoursBeforeStart: (10 - idx) * 10,
          refundPercent: (10 - idx) * 10,
        })),
        expectedKey: 'pricing.policy.invalidRuleCount',
      },
    ];

    for (const c of cases) {
      const res = await adminPost<Record<string, unknown>>(
        `/admin/pricing/products/${tour.productId}/cancellation-policies`,
        { rules: c.rules },
      );
      expect(res.status).toBe(422);
      expect(res.body['i18nKey']).toBe(c.expectedKey);
    }
  });

  it('AC6: pure computeRefund table for VND (floor rounding) and USD 999 @ 50% -> 499', () => {
    const startsAt = '2026-12-20T08:00:00Z';
    const paidVnd = 1_000_001n;

    expect(
      computeRefund({
        rules: standardRules,
        startsAt,
        cancelledAt: '2026-12-18T08:00:00Z', // exactly 48h before
        paidAmountMinor: paidVnd,
        currency: 'VND',
      }),
    ).toMatchObject({ refundPercent: 100, refundAmountMinor: 1_000_001n });

    expect(
      computeRefund({
        rules: standardRules,
        startsAt,
        cancelledAt: '2026-12-18T08:01:00Z', // 47h59m before -> 50% floor
        paidAmountMinor: paidVnd,
        currency: 'VND',
      }),
    ).toMatchObject({ refundPercent: 50, refundAmountMinor: 500_000n });

    expect(
      computeRefund({
        rules: standardRules,
        startsAt,
        cancelledAt: '2026-12-19T08:00:00Z', // exactly 24h before
        paidAmountMinor: paidVnd,
        currency: 'VND',
      }),
    ).toMatchObject({ refundPercent: 50, refundAmountMinor: 500_000n });

    expect(
      computeRefund({
        rules: standardRules,
        startsAt,
        cancelledAt: '2026-12-20T07:59:00Z', // 1 min before
        paidAmountMinor: paidVnd,
        currency: 'VND',
      }),
    ).toMatchObject({ refundPercent: 0, refundAmountMinor: 0n });

    expect(
      computeRefund({
        rules: standardRules,
        startsAt,
        cancelledAt: '2026-12-20T08:01:00Z', // after start
        paidAmountMinor: paidVnd,
        currency: 'VND',
      }),
    ).toMatchObject({ refundPercent: 0, refundAmountMinor: 0n, ruleApplied: null });

    expect(
      computeRefund({
        rules: standardRules,
        startsAt,
        cancelledAt: '2026-12-19T08:00:00Z', // 24h before -> 50% of 999 = 499.5 -> 499
        paidAmountMinor: 999n,
        currency: 'USD',
      }),
    ).toMatchObject({ refundPercent: 50, refundAmountMinor: 499n });
  });

  it('AC7: quote typed errors (no_price, no_policy, pax_type_not_offered, invalid_pax) and 404 on draft product', async () => {
    const draft = await createPublishedTour({
      namePrefix: 'AC7 Draft',
      slugSuffix: 'ac7-draft',
      publish: false,
    });
    const draftDep = await generateDeparture(draft.productId, futureUtcDateString(5));
    await adminPost(`/admin/pricing/products/${draft.productId}/cancellation-policies`, {
      rules: standardRules,
    });
    await adminPost(`/admin/pricing/products/${draft.productId}/price-lists`, {
      currency: 'VND',
      validFrom: futureUtcDateString(1),
      items: [{ paxType: 'adult', amountMinor: '950000', minAge: 10, occupiesSeat: true }],
    });

    const pubDraftRes = await fetch(
      `${baseUrl}/catalog/products/${draft.productId}/quote?departureId=${draftDep}&adult=1`,
    );
    expect(pubDraftRes.status).toBe(404);

    // Tour with no price list for date, then price list without child, then missing policy check
    const tour = await createPublishedTour({
      namePrefix: 'AC7 Errors',
      slugSuffix: 'ac7-errors',
    });
    const depUnpriced = await generateDeparture(tour.productId, futureUtcDateString(10));
    const depPriced = await generateDeparture(tour.productId, futureUtcDateString(20));

    // Invalid pax: 0 adults & 51 total pax
    const zeroAdult = await pricingService.quote({
      departureId: depPriced,
      pax: { adult: 0, child: 1 },
    });
    expect(zeroAdult).toMatchObject({ ok: false, code: 'invalid_pax' });

    const overMax = await pricingService.quote({
      departureId: depPriced,
      pax: { adult: 40, child: 11 },
    });
    expect(overMax).toMatchObject({ ok: false, code: 'invalid_pax' });

    // Only adult offered on depPriced date, no policy yet -> check pax_type_not_offered & no_policy
    await adminPost(`/admin/pricing/products/${tour.productId}/price-lists`, {
      currency: 'VND',
      validFrom: futureUtcDateString(15),
      validTo: futureUtcDateString(25),
      items: [{ paxType: 'adult', amountMinor: '950000', minAge: 10, occupiesSeat: true }],
    });

    const noPrice = await pricingService.quote({ departureId: depUnpriced, pax: { adult: 1 } });
    expect(noPrice).toMatchObject({ ok: false, code: 'no_price' });

    const noChild = await pricingService.quote({
      departureId: depPriced,
      pax: { adult: 1, child: 1 },
    });
    expect(noChild).toMatchObject({ ok: false, code: 'pax_type_not_offered' });

    const noPolicy = await pricingService.quote({ departureId: depPriced, pax: { adult: 1 } });
    expect(noPolicy).toMatchObject({ ok: false, code: 'no_policy' });
  });

  it('AC8: public quote strips internal ids & formats vi/en currency; product detail exposes fromPrice and cancellationSummary', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'AC8 Public Output',
      slugSuffix: 'ac8-public-output',
    });
    const d5 = futureUtcDateString(5);
    const d12 = futureUtcDateString(12);
    const dep5 = await generateDeparture(tour.productId, d5);
    await generateDeparture(tour.productId, d12);

    // Before prices exist -> fromPrice must be null on public product detail
    const detailNoPriceRes = await fetch(`${baseUrl}/catalog/products/vi/${tour.viSlug}`);
    expect(detailNoPriceRes.status).toBe(200);
    const detailNoPrice = (await detailNoPriceRes.json()) as PublicCatalogProductDetail;
    expect(detailNoPrice.fromPrice).toBeNull();
    expect(detailNoPrice.cancellationSummary).toBeNull();

    await adminPost(`/admin/pricing/products/${tour.productId}/cancellation-policies`, {
      rules: standardRules,
      weatherClause: 'Hủy do bão hoàn 100%',
    });

    // Price list covering d5..d6 (950000) and broader list covering d10..d15 (1200000) -> fromPrice must be 950000
    await adminPost(`/admin/pricing/products/${tour.productId}/price-lists`, {
      currency: 'VND',
      validFrom: d5,
      validTo: d5,
      items: [
        { paxType: 'adult', amountMinor: '950000', minAge: 10, occupiesSeat: true },
        { paxType: 'child', amountMinor: '650000', minAge: 5, maxAge: 9, occupiesSeat: true },
      ],
    });
    await adminPost(`/admin/pricing/products/${tour.productId}/price-lists`, {
      currency: 'VND',
      validFrom: d12,
      validTo: d12,
      items: [{ paxType: 'adult', amountMinor: '1200000', minAge: 10, occupiesSeat: true }],
    });

    const detailViRes = await fetch(`${baseUrl}/catalog/products/vi/${tour.viSlug}`);
    expect(detailViRes.status).toBe(200);
    const detailVi = (await detailViRes.json()) as PublicCatalogProductDetail;
    expect(detailVi.fromPrice).not.toBeNull();
    expect(detailVi.fromPrice?.amountMinor).toBe('950000');
    expect(detailVi.fromPrice?.currency).toBe('VND');
    expect(detailVi.fromPrice?.formatted).toContain('950.000');
    expect(detailVi.cancellationSummary).toEqual({
      version: 1,
      rules: standardRules,
      weatherClause: 'Hủy do bão hoàn 100%',
    });

    // Public quote in vi and en: check exact formatted output & absent internal fields
    const quoteViRes = await fetch(
      `${baseUrl}/catalog/products/${tour.productId}/quote?departureId=${dep5}&adult=1&locale=vi`,
    );
    expect(quoteViRes.status).toBe(200);
    const quoteViRaw = await quoteViRes.text();
    expect(quoteViRaw).not.toContain('priceListId');
    expect(quoteViRaw).not.toContain('cancellationPolicyId');
    expect(quoteViRaw).not.toContain('createdBy');
    expect(quoteViRaw).not.toContain('created_by');
    const quoteVi = JSON.parse(quoteViRaw) as PublicQuoteResponse;
    expect(quoteVi.priceListVersion).toBe(1);
    expect(quoteVi.cancellationPolicyVersion).toBe(1);
    expect(quoteVi.totalFormatted).toContain('950.000');
    expect(quoteVi.totalFormatted).toContain('₫');

    const quoteEnRes = await fetch(
      `${baseUrl}/catalog/products/${tour.productId}/quote?departureId=${dep5}&adult=1&locale=en`,
    );
    expect(quoteEnRes.status).toBe(200);
    const quoteEn = (await quoteEnRes.json()) as PublicQuoteResponse;
    expect(quoteEn.totalFormatted).toContain('₫950,000');
  });

  it('AC9 (L1 carry-over): changing product timeZone is allowed without departures and rejected with 422 once departures exist', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'AC9 L1 TimeZone',
      slugSuffix: 'ac9-l1-tz',
    });

    expect(await inventoryService.hasDepartures(tour.productId)).toBe(false);

    // Allowed when no departures exist
    const patchAllowed = await adminPatch<AdminCatalogProductDto>(
      `/admin/products/${tour.productId}`,
      { timeZone: 'Asia/Bangkok' },
    );
    expect(patchAllowed.status).toBe(200);
    expect(patchAllowed.body.timeZone).toBe('Asia/Bangkok');

    // Create a departure -> hasDepartures becomes true
    await generateDeparture(tour.productId, futureUtcDateString(3));
    expect(await inventoryService.hasDepartures(tour.productId)).toBe(true);

    // Changing timeZone now MUST fail with 422 i18nKey
    const patchRejected = await adminPatch<Record<string, unknown>>(
      `/admin/products/${tour.productId}`,
      { timeZone: 'Asia/Tokyo' },
    );
    expect(patchRejected.status).toBe(422);
    expect(patchRejected.body['i18nKey']).toBe('catalog.product.timeZoneHasDepartures');

    // Same-value update (unchanged timeZone) remains allowed
    const patchSame = await adminPatch<AdminCatalogProductDto>(
      `/admin/products/${tour.productId}`,
      { timeZone: 'Asia/Bangkok' },
    );
    expect(patchSame.status).toBe(200);
  });

  it('AC10: anonymous returns 401, customer returns 403 on admin pricing endpoints, and @Idempotent replays same version', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'AC10 Auth Idem',
      slugSuffix: 'ac10-auth-idem',
    });

    const priceBody = {
      currency: 'VND',
      validFrom: '2027-01-01',
      items: [{ paxType: 'adult', amountMinor: '750000', minAge: 10, occupiesSeat: true }],
    };

    const anon = await fetch(`${baseUrl}/admin/pricing/products/${tour.productId}/price-lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': nextIdemKey() },
      body: JSON.stringify(priceBody),
    });
    expect(anon.status).toBe(401);

    const cust = await fetch(`${baseUrl}/admin/pricing/products/${tour.productId}/price-lists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify(priceBody),
    });
    expect(cust.status).toBe(403);

    const key = nextIdemKey();
    const first = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      priceBody,
      key,
    );
    const replay = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      priceBody,
      key,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.version).toBe(1);
    expect(replay.body.createdBy.length).toBeGreaterThan(0);

    const listAll = await fetch(`${baseUrl}/admin/pricing/products/${tour.productId}/price-lists`, {
      headers: { Cookie: adminCookie },
    });
    const listJson = (await listAll.json()) as { items: AdminPriceListDto[] };
    expect(listJson.items).toHaveLength(1);
  });

  it('R1: price_list_items reject late-transaction appends (23001) and price_lists require adult item at commit (23514)', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'R1 Trigger Guard',
      slugSuffix: 'r1-trigger-guard',
    });

    const v1 = await adminPost<AdminPriceListDto>(
      `/admin/pricing/products/${tour.productId}/price-lists`,
      {
        currency: 'VND',
        validFrom: '2027-01-01',
        items: [{ paxType: 'adult', amountMinor: '600000', minAge: 12, occupiesSeat: true }],
      },
    );
    expect(v1.status).toBe(201);

    const lateClient = await testDb.pool.connect();
    try {
      await lateClient.query('BEGIN');
      let lateCode: string | undefined;
      try {
        await lateClient.query(
          `INSERT INTO pricing.price_list_items (price_list_id, pax_type, amount_minor, min_age, max_age, occupies_seat)
           VALUES ($1, 'child', 300000, 2, 11, true)`,
          [v1.body.id],
        );
      } catch (err) {
        lateCode = (err as { code?: string }).code;
      }
      await lateClient.query('ROLLBACK');
      expect(lateCode).toBe('23001');
    } finally {
      lateClient.release();
    }

    const noAdultClient = await testDb.pool.connect();
    try {
      await noAdultClient.query('BEGIN');
      const orphanListId = randomUUID();
      await noAdultClient.query(
        `INSERT INTO pricing.price_lists (id, product_id, version, currency, valid_from, valid_to, created_by)
         VALUES ($1, $2, 99, 'VND', '2028-01-01', NULL, 'r1-test-user')`,
        [orphanListId, tour.productId],
      );
      await noAdultClient.query(
        `INSERT INTO pricing.price_list_items (price_list_id, pax_type, amount_minor, min_age, max_age, occupies_seat)
         VALUES ($1, 'child', 250000, 2, 11, true)`,
        [orphanListId],
      );
      let commitCode: string | undefined;
      try {
        await noAdultClient.query('COMMIT');
      } catch (err) {
        commitCode = (err as { code?: string }).code;
        await noAdultClient.query('ROLLBACK');
      }
      expect(commitCode).toBe('23514');
    } finally {
      noAdultClient.release();
    }
  });

  it('R2: CatalogService fails closed (503) when INVENTORY_DEPARTURE_CHECK_PORT is unbound and a timeZone change is requested', async () => {
    const tour = await createPublishedTour({
      namePrefix: 'R2 Fail Closed',
      slugSuffix: 'r2-fail-closed',
    });

    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    const isolatedModule = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        I18nModule,
        IdempotencyModule,
        IdentityModule,
        SupplyModule,
        CatalogModule,
      ],
    }).compile();

    try {
      await isolatedModule.init();
      const isolatedCatalog = isolatedModule.get(CatalogService);

      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('INVENTORY_DEPARTURE_CHECK_PORT'),
        ),
      ).toBe(true);

      await expect(
        isolatedCatalog.updateProduct(tour.productId, { timeZone: 'Asia/Bangkok' }),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes('INVENTORY_DEPARTURE_CHECK_PORT'),
        ),
      ).toBe(true);

      const dbRow = await testDb.pool.query<{ time_zone: string }>(
        'SELECT time_zone FROM catalog.products WHERE id = $1',
        [tour.productId],
      );
      expect(dbRow.rows[0]?.time_zone).toBe('Asia/Ho_Chi_Minh');

      // Non-timeZone edits remain operational while the port is unbound
      const unchangedTz = await isolatedCatalog.updateProduct(tour.productId, {
        region: 'Hạ Long',
      });
      expect(unchangedTz.region).toBe('Hạ Long');
      expect(unchangedTz.timeZone).toBe('Asia/Ho_Chi_Minh');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await isolatedModule.close();
    }
  });

  it('R3: concurrent timeZone change and departure generation serialize under FOR UPDATE / FOR SHARE', async () => {
    // 1. Concurrent 2-connection barrier races
    for (let round = 0; round < 5; round++) {
      const tour = await createPublishedTour({
        namePrefix: `R3 Barrier ${round}`,
        slugSuffix: `r3-barrier-${round}`,
      });
      const barrier = createStartBarrier(2);

      const updateTask = (async () => {
        await barrier();
        return catalogService.updateProduct(tour.productId, { timeZone: 'Asia/Tokyo' });
      })();

      const generateTask = (async () => {
        await barrier();
        return inventoryService.generateDepartures(tour.productId, {
          fromDate: '2027-06-15',
          toDate: '2027-06-15',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          localTimes: ['09:00'],
          capacity: 15,
        });
      })();

      const [updateResult, generateResult] = await Promise.allSettled([updateTask, generateTask]);
      expect(generateResult.status).toBe('fulfilled');

      const prodRes = await testDb.pool.query<{ time_zone: string }>(
        'SELECT time_zone FROM catalog.products WHERE id = $1',
        [tour.productId],
      );
      const depRes = await testDb.pool.query<{ starts_at: Date }>(
        'SELECT starts_at FROM inventory.departures WHERE product_id = $1',
        [tour.productId],
      );
      expect(depRes.rows).toHaveLength(1);
      const actualUtc = depRes.rows[0]!.starts_at.toISOString();

      if (updateResult.status === 'fulfilled') {
        // Update committed first: final timeZone is Asia/Tokyo (+09:00) -> 09:00 local = 00:00Z
        expect(prodRes.rows[0]?.time_zone).toBe('Asia/Tokyo');
        expect(actualUtc).toBe('2027-06-15T00:00:00.000Z');
      } else {
        // Generate committed first: final timeZone stays Asia/Ho_Chi_Minh (+07:00) -> 09:00 local = 02:00Z
        expect(prodRes.rows[0]?.time_zone).toBe('Asia/Ho_Chi_Minh');
        expect(actualUtc).toBe('2027-06-15T02:00:00.000Z');
      }
    }

    // 2. Deterministic lock-order interleaving: connection A locks product FOR UPDATE & updates to Asia/Tokyo,
    // connection B starts generateDepartures (FOR SHARE blocks until A commits) and must compute starts_at in Asia/Tokyo
    const lockTour = await createPublishedTour({
      namePrefix: 'R3 Lock Order',
      slugSuffix: 'r3-lock-order',
    });
    const lockConn = await testDb.pool.connect();
    let committedA = false;
    try {
      await lockConn.query('BEGIN');
      await lockConn.query('SELECT id FROM catalog.products WHERE id = $1 FOR UPDATE', [
        lockTour.productId,
      ]);
      await lockConn.query("UPDATE catalog.products SET time_zone = 'Asia/Tokyo' WHERE id = $1", [
        lockTour.productId,
      ]);

      const genPromise = inventoryService
        .generateDepartures(lockTour.productId, {
          fromDate: '2027-06-15',
          toDate: '2027-06-15',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          localTimes: ['09:00'],
          capacity: 10,
        })
        .then((res) => ({ res, sawCommit: committedA }));

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(committedA).toBe(false);
      committedA = true;
      await lockConn.query('COMMIT');

      const genOutcome = await genPromise;
      expect(genOutcome.sawCommit).toBe(true);
      expect(genOutcome.res.createdCount).toBe(1);

      const depRes = await testDb.pool.query<{ starts_at: Date }>(
        'SELECT starts_at FROM inventory.departures WHERE product_id = $1',
        [lockTour.productId],
      );
      expect(depRes.rows[0]?.starts_at.toISOString()).toBe('2027-06-15T00:00:00.000Z');
    } finally {
      lockConn.release();
    }
  });
});
