import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type DatabaseClient, seedReferenceData } from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../test/test-db.js';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';
import { DRIZZLE_DB } from '../database/database.module.js';
import {
  CatalogService,
  type PublicCatalogListResponse,
  type PublicCatalogProductDetail,
} from '../modules/catalog/index.js';
import { InventoryService, type PublicAvailabilityResponse } from '../modules/inventory/index.js';
import { PricingService, type PublicQuoteResponse } from '../modules/pricing/index.js';
import { SupplyService } from '../modules/supply/index.js';
import {
  loadDemoCatalogFromFile,
  parseAgeBand,
  resolveDemoCatalogPath,
  runDemoLoader,
  validateDemoCatalogJson,
} from './demo-loader.js';
import {
  assertStagingCleanupEnvAllowed,
  runStagingCleanupTestData,
} from './staging-cleanup-test-data.js';

const TEST_AUTH_SECRET = 'p2-09a-demo-loader-test-secret-at-least-32-chars';

describe('Phu Quoc demo loader & customer browse API integration tests (P2-09A)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let supplyService: SupplyService;
  let catalogService: CatalogService;
  let inventoryService: InventoryService;
  let pricingService: PricingService;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousTrustedOrigins: string | undefined;
  let previousTrustedProxyCidrs: string | undefined;
  let previousBossDisabled: string | undefined;
  let previousAppEnv: string | undefined;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousTrustedOrigins = process.env['AUTH_TRUSTED_ORIGINS'];
    previousTrustedProxyCidrs = process.env['TRUSTED_PROXY_CIDRS'];
    previousBossDisabled = process.env['PG_BOSS_DISABLED'];
    previousAppEnv = process.env['APP_ENV'];

    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3000,http://127.0.0.1';
    process.env['TRUSTED_PROXY_CIDRS'] = '127.0.0.1/32,::1/128';
    process.env['PG_BOSS_DISABLED'] = 'true';
    process.env['APP_ENV'] = 'test';

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
    supplyService = moduleFixture.get(SupplyService);
    catalogService = moduleFixture.get(CatalogService);
    inventoryService = moduleFixture.get(InventoryService);
    pricingService = moduleFixture.get(PricingService);
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
    if (previousAppEnv === undefined) delete process.env['APP_ENV'];
    else process.env['APP_ENV'] = previousAppEnv;
    await testDb?.teardown();
  });

  it('AC1 & AC2 & AC4: loads 3 suppliers, 8 published products (+1 draft transfer), price lists, policies, 61 days departures idempotently', async () => {
    expect(parseAgeBand('10+')).toEqual({ minAge: 10, maxAge: null });
    expect(parseAgeBand('5-9')).toEqual({ minAge: 5, maxAge: 9 });
    expect(parseAgeBand('0-4')).toEqual({ minAge: 0, maxAge: 4 });

    const fixedNow = new Date('2026-11-27T01:00:00.000Z');
    const logsRun1: string[] = [];
    const run1 = await runDemoLoader(
      { supplyService, catalogService, inventoryService, pricingService },
      {
        now: fixedNow,
        log: (line) => logsRun1.push(line),
      },
    );

    expect(run1.suppliersCreated).toBe(3);
    expect(run1.suppliersReused).toBe(0);
    expect(run1.productsCreated).toBe(9);
    expect(run1.productsPublished).toBe(8);
    expect(run1.productsDraftKept).toBe(1);
    expect(run1.translationsUpserted).toBe(18);
    expect(run1.priceListsCreated).toBe(8);
    expect(run1.policiesCreated).toBe(8);
    // 6 products * 1 daily departure + 2 products * 2 daily departures = 10 departures/day * 61 days = 610
    expect(run1.departuresCreated).toBe(610);
    expect(run1.departuresSkipped).toBe(0);
    expect(logsRun1.some((l) => l.includes('draft'))).toBe(true);

    // Second run with the same date must be a 100% no-op
    const run2 = await runDemoLoader(
      { supplyService, catalogService, inventoryService, pricingService },
      {
        now: fixedNow,
        log: () => undefined,
      },
    );

    expect(run2.suppliersCreated).toBe(0);
    expect(run2.suppliersReused).toBe(3);
    expect(run2.productsCreated).toBe(0);
    expect(run2.productsPublished).toBe(0);
    expect(run2.productsDraftKept).toBe(1);
    expect(run2.translationsUpserted).toBe(0);
    expect(run2.priceListsCreated).toBe(0);
    expect(run2.priceListsReused).toBe(8);
    expect(run2.policiesCreated).toBe(0);
    expect(run2.policiesReused).toBe(8);
    expect(run2.departuresCreated).toBe(0);
    expect(run2.departuresSkipped).toBe(610);

    // Next-day run adds only the 1 new rolling day (+61 -> 10 departures), reusing everything else
    const nextDayNow = new Date(fixedNow.getTime() + 86_400_000);
    const run3 = await runDemoLoader(
      { supplyService, catalogService, inventoryService, pricingService },
      {
        now: nextDayNow,
        log: () => undefined,
      },
    );
    expect(run3.productsCreated).toBe(0);
    expect(run3.priceListsCreated).toBe(0);
    expect(run3.policiesCreated).toBe(0);
    expect(run3.departuresCreated).toBe(10);
    expect(run3.departuresSkipped).toBe(600);

    // Verify public catalog list returns 8 items with fromPrice, excluding the draft transfer
    const listRes = await fetch(`${baseUrl}/catalog/products?locale=vi&limit=20`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as PublicCatalogListResponse;
    expect(listJson.items).toHaveLength(8);
    for (const item of listJson.items) {
      expect(item.fromPrice).not.toBeNull();
    }

    // Accent-insensitive search for "hon thom" finds the cable car tour
    const searchRes = await fetch(`${baseUrl}/catalog/products?locale=vi&q=hon%20thom`);
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as PublicCatalogListResponse;
    expect(
      searchJson.items.some((i) => i.slug === 'tour-cano-4-dao-ket-hop-cap-treo-hon-thom'),
    ).toBe(true);

    // Detail endpoint includes alternateSlugs for language switching & quote checks
    const detailViRes = await fetch(`${baseUrl}/catalog/products/vi/tour-cano-4-dao-nam-phu-quoc`);
    expect(detailViRes.status).toBe(200);
    const detailVi = (await detailViRes.json()) as PublicCatalogProductDetail;
    expect(detailVi.alternateSlugs).toEqual({
      vi: 'tour-cano-4-dao-nam-phu-quoc',
      en: 'south-phu-quoc-4-island-speedboat-tour',
    });
    expect(detailVi.fromPrice?.amountMinor).toBe('950000');

    // Public availability returns 61-day departures with 40 seats initially
    const fromDate = '2026-11-28';
    const toDate = '2026-12-10';
    const availRes = await fetch(
      `${baseUrl}/catalog/products/${detailVi.id}/availability?from=${fromDate}&to=${toDate}`,
    );
    expect(availRes.status).toBe(200);
    const availJson = (await availRes.json()) as PublicAvailabilityResponse;
    expect(availJson.items.length).toBeGreaterThan(5);
    const targetDep = availJson.items.find((d) => d.localDate === '2026-12-05')!;
    expect(targetDep.remaining).toBe(40);

    // Quote for "Tour cano 4 đảo": 2 adults (950k*2) + 1 child (650k) + 1 infant (0) = 2,550,000 VND, seats=3
    const quoteViRes = await fetch(
      `${baseUrl}/catalog/products/${detailVi.id}/quote?departureId=${targetDep.id}&adult=2&child=1&infant=1&locale=vi`,
    );
    expect(quoteViRes.status).toBe(200);
    const quoteVi = (await quoteViRes.json()) as PublicQuoteResponse;
    expect(quoteVi.totalAmountMinor).toBe('2550000');
    expect(quoteVi.seats).toBe(3);
    expect(quoteVi.totalFormatted.replace(/\u00a0/g, ' ')).toBe('2.550.000 ₫');

    const quoteEnRes = await fetch(
      `${baseUrl}/catalog/products/${detailVi.id}/quote?departureId=${targetDep.id}&adult=2&child=1&infant=1&locale=en`,
    );
    expect(quoteEnRes.status).toBe(200);
    const quoteEn = (await quoteEnRes.json()) as PublicQuoteResponse;
    expect(quoteEn.totalFormatted).toBe('₫2,550,000');

    // Scuba adult-only rejects child=1 with 422 pax_type_not_offered
    const scubaDetailRes = await fetch(
      `${baseUrl}/catalog/products/vi/lan-binh-khi-trai-nghiem-nguoi-moi`,
    );
    const scubaDetail = (await scubaDetailRes.json()) as PublicCatalogProductDetail;
    const scubaAvailRes = await fetch(
      `${baseUrl}/catalog/products/${scubaDetail.id}/availability?from=2026-12-01&to=2026-12-07`,
    );
    const scubaAvail = (await scubaAvailRes.json()) as PublicAvailabilityResponse;
    const scubaQuoteRes = await fetch(
      `${baseUrl}/catalog/products/${scubaDetail.id}/quote?departureId=${scubaAvail.items[0]!.id}&adult=1&child=1&locale=en`,
    );
    expect(scubaQuoteRes.status).toBe(422);
    const scubaErr = (await scubaQuoteRes.json()) as {
      code?: string;
      i18nKey?: string;
      detail?: string;
    };
    expect(scubaErr.code).toBe('pax_type_not_offered');
    expect(scubaErr.detail).toContain('child');

    // AC4: allocate 3 seats -> remaining becomes 37; closing another hides it completely
    const alloc = await inventoryService.allocate({
      departureId: targetDep.id,
      quantity: 3,
      refType: 'test_p209a',
      refId: '01950000-0000-7000-8000-000000009001',
    });
    expect(alloc.status).toBe('allocated');

    const closedDep = availJson.items.find((d) => d.localDate === '2026-12-06')!;
    await inventoryService.closeDeparture(closedDep.id);

    const availAfterRes = await fetch(
      `${baseUrl}/catalog/products/${detailVi.id}/availability?from=2026-12-05&to=2026-12-06`,
    );
    const availAfter = (await availAfterRes.json()) as PublicAvailabilityResponse;
    const updatedTarget = availAfter.items.find((d) => d.id === targetDep.id);
    expect(updatedTarget?.remaining).toBe(37);
    expect(availAfter.items.some((d) => d.id === closedDep.id)).toBe(false);

    // Verify db connection was active
    const depCheck = await db.execute('SELECT COUNT(*)::int AS cnt FROM inventory.departures');
    expect(Number((depCheck.rows[0] as Record<string, unknown>)['cnt'])).toBeGreaterThan(0);
  });

  it('AC1 guards: refuses suppliers lacking "(Demo)" and refuses APP_ENV=production with exit 1', async () => {
    const rawCatalog = await loadDemoCatalogFromFile(resolveDemoCatalogPath());
    const badCatalog = {
      ...rawCatalog,
      suppliers: rawCatalog.suppliers.map((s, idx) =>
        idx === 0 ? { ...s, name: 'Real Operator Travel' } : s,
      ),
    };
    expect(() => validateDemoCatalogJson(badCatalog)).toThrow(/\(Demo\)/);

    const distEntry = resolve(import.meta.dirname, '../../dist/scripts/demo-load.js');
    const buildCheck = spawnSync('pnpm', ['--filter', '@internationalota/api', 'build'], {
      cwd: resolve(import.meta.dirname, '../../'),
      encoding: 'utf8',
    });
    expect(buildCheck.status).toBe(0);

    const prodRun = spawnSync('node', [distEntry], {
      env: { ...process.env, APP_ENV: 'production' },
      encoding: 'utf8',
    });
    expect(prodRun.status).toBe(1);
    expect(prodRun.stderr).toContain('production');
  });

  it('U6: staging-cleanup-test-data refuses non-staging envs, archives synthetic test products, and preserves the 8 demo tours', async () => {
    process.env['APP_ENV'] = 'production';
    expect(() => assertStagingCleanupEnvAllowed()).toThrow(/production/i);

    process.env['APP_ENV'] = 'local';
    expect(() => assertStagingCleanupEnvAllowed()).toThrow(/APP_ENV=staging/i);

    // Seed a synthetic test supplier & product (like P2-07/P2-08 manual staging probes)
    const testSupplier = await supplyService.createSupplier({
      name: 'E2E Test Supplier a77bf7f6',
      countryAlpha2: 'VN',
      contactEmail: 'e2e-test@example.com',
      contactPhone: '+84901234567',
    });
    const testProduct = await catalogService.createProduct({
      supplierId: testSupplier.id,
      kind: 'tour',
      countryAlpha2: 'VN',
      region: 'Phú Quốc',
      location: { lat: 10.02, lng: 104.01 },
      timeZone: 'Asia/Ho_Chi_Minh',
      durationMinutes: 180,
    });
    await catalogService.upsertTranslation(testProduct.id, 'vi', {
      title: 'Test Tour a77bf7f6',
      slug: 'pq-p208-vi-a77bf7f6',
      summary: 'Synthetic test product',
      description: 'Should be archived by staging cleanup',
    });
    await catalogService.upsertTranslation(testProduct.id, 'en', {
      title: 'Test Tour EN a77bf7f6',
      slug: 'pq-p208-en-a77bf7f6',
      summary: 'Synthetic test product EN',
      description: 'Should be archived by staging cleanup',
    });
    await catalogService.publishProduct(testProduct.id);

    process.env['APP_ENV'] = 'staging';
    try {
      const cleanupRes = await runStagingCleanupTestData(db);
      expect(cleanupRes.archivedProductsCount).toBe(1);
      expect(cleanupRes.archivedProductSlugs).toContain('pq-p208-vi-a77bf7f6');
      expect(cleanupRes.suspendedSuppliersCount).toBe(1);
      expect(cleanupRes.remainingPublicProductsCount).toBe(8);

      const listAfter = await fetch(`${baseUrl}/catalog/products?locale=vi&limit=20`);
      const bodyAfter = (await listAfter.json()) as PublicCatalogListResponse;
      expect(bodyAfter.items).toHaveLength(8);
      expect(bodyAfter.items.some((item) => item.slug.includes('pq-p208'))).toBe(false);
    } finally {
      process.env['APP_ENV'] = 'test';
    }
  });
});
