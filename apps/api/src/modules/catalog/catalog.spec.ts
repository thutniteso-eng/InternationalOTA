import {
  assertFixturesAllowed,
  type DatabaseClient,
  grantRoleByEmail,
  seedCatalogDevFixtures,
  seedReferenceData,
} from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import type { SupplierRecord } from '../supply/index.js';
import type {
  AdminCatalogProductDto,
  PublicCatalogListResponse,
  PublicCatalogProductDetail,
} from './catalog.types.js';

const TEST_AUTH_SECRET = 'p2-01-catalog-test-secret-at-least-32-characters';

function extractCookieHeader(res: Response): string {
  const setCookies = res.headers.getSetCookie();
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6_371_008.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

describe('Supply & Catalog modules integration tests (P2-01)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;

  let adminCookie: string;
  let customerCookie: string;

  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousTrustedOrigins: string | undefined;
  let previousTrustedProxyCidrs: string | undefined;
  let previousBossDisabled: string | undefined;

  let idemSeq = 0;
  const nextIdemKey = () => `p2-01-key-${++idemSeq}`;

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

    adminCookie = await signUpAndSignIn(
      'catalog-admin@example.com',
      'CatalogAdmin!2026',
      'Catalog Admin',
      '10.10.0.1',
      true,
    );
    customerCookie = await signUpAndSignIn(
      'catalog-customer@example.com',
      'CatalogCust!2026',
      'Catalog Customer',
      '10.10.0.2',
      false,
    );
  }, 60_000);

  afterAll(async () => {
    await app?.close();
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

  async function adminPost<T>(
    path: string,
    body?: unknown,
    key = nextIdemKey(),
  ): Promise<{
    status: number;
    headers: Headers;
    body: T;
  }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': key,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as T };
  }

  async function adminPut<T>(
    path: string,
    body: unknown,
    key = nextIdemKey(),
  ): Promise<{
    status: number;
    body: T;
  }> {
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

  it('AC7: anonymous returns 401, customer returns 403 on admin endpoints, and @Idempotent replays identical create response', async () => {
    const anonRes = await fetch(`${baseUrl}/admin/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': nextIdemKey() },
      body: JSON.stringify({ name: 'Anon Co', countryAlpha2: 'VN' }),
    });
    expect(anonRes.status).toBe(401);

    const custRes = await fetch(`${baseUrl}/admin/suppliers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: customerCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({ name: 'Cust Co', countryAlpha2: 'VN' }),
    });
    expect(custRes.status).toBe(403);

    const idemKey = nextIdemKey();
    const payload = {
      name: 'Phu Quoc Boat Ops',
      legalName: 'Phu Quoc Boat Operations LLC',
      countryAlpha2: 'VN',
      contactEmail: 'ops-secret@boatops.example',
      contactPhone: '+84911222333',
    };

    const first = await adminPost<SupplierRecord>('/admin/suppliers', payload, idemKey);
    expect(first.status).toBe(201);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();

    const replay = await adminPost<SupplierRecord>('/admin/suppliers', payload, idemKey);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    // Product create idempotent replay
    const prodKey = nextIdemKey();
    const prodPayload = {
      supplierId: first.body.id,
      kind: 'tour',
      countryAlpha2: 'VN',
      region: 'Phú Quốc',
      timeZone: 'Asia/Ho_Chi_Minh',
    };
    const p1 = await adminPost<AdminCatalogProductDto>('/admin/products', prodPayload, prodKey);
    expect(p1.status).toBe(201);
    const p2 = await adminPost<AdminCatalogProductDto>('/admin/products', prodPayload, prodKey);
    expect(p2.status).toBe(201);
    expect(p2.headers.get('Idempotent-Replayed')).toBe('true');
    expect(p2.body.id).toBe(p1.body.id);
  });

  it('AC1 & AC2 & AC8: publish rules enforced with 422 i18nKey; draft/archived/suspended hidden; supplier contacts never leak', async () => {
    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: 'Island Breeze Co',
      legalName: 'Island Breeze Private Legal Name',
      countryAlpha2: 'VN',
      contactEmail: 'topsecret-supplier@example.com',
      contactPhone: '+84988777666',
    });
    const supplierId = sup.body.id;

    // Suspend supplier first
    const suspRes = await adminPost<SupplierRecord>(`/admin/suppliers/${supplierId}/suspend`);
    expect(suspRes.status).toBe(200);
    expect(suspRes.body.status).toBe('suspended');

    // Create complete product WITH location and both translations while supplier is suspended
    const created = await adminPost<AdminCatalogProductDto>('/admin/products', {
      supplierId,
      kind: 'activity',
      countryAlpha2: 'VN',
      region: 'Phú Quốc',
      location: { lat: 10.227, lng: 103.957 },
      meetingPointNote: 'Dinh Cau Pier',
      timeZone: 'Asia/Ho_Chi_Minh',
      durationMinutes: 120,
    });
    const productId = created.body.id;

    await adminPut(`/admin/products/${productId}/translations/vi`, {
      title: 'Chèo SUP Hoàng Hôn Phú Quốc',
      slug: 'cheo-sup-hoang-hon-phu-quoc',
      summary: 'Hoạt động chèo SUP ngắm hoàng hôn tại Dinh Cậu.',
      description: 'Mô tả chi tiết hoạt động chèo SUP an toàn cho mọi lứa tuổi.',
      highlights: ['Ngắm hoàng hôn', 'Hướng dẫn viên đi kèm'],
    });
    await adminPut(`/admin/products/${productId}/translations/en`, {
      title: 'Phu Quoc Sunset SUP Paddle',
      slug: 'phu-quoc-sunset-sup-paddle',
      summary: 'Sunset paddleboarding experience off Dinh Cau.',
      description: 'Guided beginner-friendly sunset stand-up paddleboarding.',
      highlights: ['Sunset views', 'Safety guide included'],
    });

    // Draft product is NOT visible on public list or slug detail
    const draftDetail = await fetch(`${baseUrl}/catalog/products/vi/cheo-sup-hoang-hon-phu-quoc`);
    expect(draftDetail.status).toBe(404);

    // 1. Publish blocked because supplier is suspended
    const blockedSuspended = await adminPost<Record<string, unknown>>(
      `/admin/products/${productId}/publish`,
    );
    expect(blockedSuspended.status).toBe(422);
    expect(blockedSuspended.body['i18nKey']).toBe('catalog.publish.supplierSuspended');

    // Reactivate supplier & create a second product missing 'en' translation and location
    await adminPost(`/admin/suppliers/${supplierId}/reactivate`);

    const incompleteProd = await adminPost<AdminCatalogProductDto>('/admin/products', {
      supplierId,
      kind: 'tour',
      countryAlpha2: 'VN',
      region: 'Phú Quốc',
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    const incompleteId = incompleteProd.body.id;
    await adminPut(`/admin/products/${incompleteId}/translations/vi`, {
      title: 'Tour Thiếu Bản Dịch',
      slug: 'tour-thieu-ban-dich',
      summary: 'Tóm tắt tour.',
      description: 'Chi tiết tour.',
    });

    // Blocked (missing en translation AND location), add location -> blocked ONLY missing en
    await fetch(`${baseUrl}/admin/products/${incompleteId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({ location: { lat: 10.22, lng: 103.95 } }),
    });
    const blockedMissingEn = await adminPost<Record<string, unknown>>(
      `/admin/products/${incompleteId}/publish`,
    );
    expect(blockedMissingEn.status).toBe(422);
    expect(blockedMissingEn.body['i18nKey']).toBe('catalog.publish.missingTranslations');
    expect(String(blockedMissingEn.body['detail'])).toContain('en');

    // Product with both translations but missing location -> blocked missingLocation
    await adminPut(`/admin/products/${incompleteId}/translations/en`, {
      title: 'Tour Missing Location',
      slug: 'tour-missing-location',
      summary: 'Summary.',
      description: 'Description.',
    });
    await fetch(`${baseUrl}/admin/products/${incompleteId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        'Idempotency-Key': nextIdemKey(),
      },
      body: JSON.stringify({ location: null }),
    });
    const blockedMissingLoc = await adminPost<Record<string, unknown>>(
      `/admin/products/${incompleteId}/publish`,
    );
    expect(blockedMissingLoc.status).toBe(422);
    expect(blockedMissingLoc.body['i18nKey']).toBe('catalog.publish.missingLocation');

    // Now publish the complete productId (including HTTPS image)
    await adminPut(`/admin/products/${productId}/images`, {
      images: [
        {
          url: 'https://cdn.example.com/sup-sunset.jpg',
          alt: { vi: 'Hoàng hôn Phú Quốc', en: 'Phu Quoc sunset' },
        },
      ],
    });
    const published = await adminPost<AdminCatalogProductDto>(
      `/admin/products/${productId}/publish`,
    );
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');
    expect(published.body.publishedAt).toBeTruthy();

    // AC8: Public list & detail work and NEVER leak supplier contact fields or internal fields
    const pubListRes = await fetch(`${baseUrl}/catalog/products?locale=en`);
    const pubListRaw = await pubListRes.text();
    expect(pubListRes.status).toBe(200);
    expect(pubListRaw).toContain('Phu Quoc Sunset SUP Paddle');
    expect(pubListRaw).not.toContain('topsecret-supplier@example.com');
    expect(pubListRaw).not.toContain('+84988777666');
    expect(pubListRaw).not.toContain('Island Breeze Private Legal Name');
    expect(pubListRaw).not.toContain('contactEmail');
    expect(pubListRaw).not.toContain('contactPhone');
    expect(pubListRaw).not.toContain('legalName');

    const pubDetailRes = await fetch(`${baseUrl}/catalog/products/vi/cheo-sup-hoang-hon-phu-quoc`);
    const pubDetailRaw = await pubDetailRes.text();
    expect(pubDetailRes.status).toBe(200);
    expect(pubDetailRaw).toContain('Chèo SUP Hoàng Hôn Phú Quốc');
    expect(pubDetailRaw).not.toContain('topsecret-supplier@example.com');
    expect(pubDetailRaw).not.toContain('+84988777666');
    expect(pubDetailRaw).not.toContain('Island Breeze Private Legal Name');

    // Suspend supplier -> hides published product immediately without changing status
    await adminPost(`/admin/suppliers/${supplierId}/suspend`);
    const hiddenList = (await (
      await fetch(`${baseUrl}/catalog/products?locale=vi`)
    ).json()) as PublicCatalogListResponse;
    expect(hiddenList.items.find((i) => i.id === productId)).toBeUndefined();
    const hiddenDetail = await fetch(`${baseUrl}/catalog/products/vi/cheo-sup-hoang-hon-phu-quoc`);
    expect(hiddenDetail.status).toBe(404);

    // Reactivate -> visible again; then archive -> hidden permanently from public
    await adminPost(`/admin/suppliers/${supplierId}/reactivate`);
    expect((await fetch(`${baseUrl}/catalog/products/vi/cheo-sup-hoang-hon-phu-quoc`)).status).toBe(
      200,
    );

    await adminPost(`/admin/products/${productId}/archive`);
    expect((await fetch(`${baseUrl}/catalog/products/vi/cheo-sup-hoang-hon-phu-quoc`)).status).toBe(
      404,
    );
  });

  it('AC3 & AC4 & AC5: i18n slug isolation, accent-insensitive search in resolved locale only, and PostGIS ST_DWithin accuracy', async () => {
    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: 'Dao Ngoc Tours',
      countryAlpha2: 'VN',
    });
    const supplierId = sup.body.id;

    // Product A: ~3.0 km from Dương Đông ref (10.2270, 103.9570)
    // Point (10.2540, 103.9570) is ~3.0 km north of (10.2270, 103.9570)
    const prodA = (
      await adminPost<AdminCatalogProductDto>('/admin/products', {
        supplierId,
        kind: 'tour',
        countryAlpha2: 'VN',
        region: 'Phú Quốc',
        location: { lat: 10.254, lng: 103.957 },
        timeZone: 'Asia/Ho_Chi_Minh',
      })
    ).body;
    await adminPut(`/admin/products/${prodA.id}/translations/vi`, {
      title: 'Tour Đảo Ngọc Khám Phá Bắc Đảo',
      slug: 'tour-dao-ngoc-bac-dao',
      summary: 'Chuyến đi trong ngày quanh khu vực Dương Đông.',
      description: 'Mô tả Tour Đảo Ngọc.',
    });
    await adminPut(`/admin/products/${prodA.id}/translations/en`, {
      title: 'North Phu Quoc Coastal Excursion',
      slug: 'north-phu-quoc-coastal-excursion',
      summary: 'Full-day sightseeing tour near Duong Dong.',
      description: 'Detailed English excursion description.',
    });
    await adminPost(`/admin/products/${prodA.id}/publish`);

    // Product B: ~40.0 km from (10.2270, 103.9570) — e.g. 10.5870, 103.9570 (~40 km north)
    // Contains 'dao ngoc' ONLY in Vietnamese translation (to prove English locale search excludes it)
    const prodB = (
      await adminPost<AdminCatalogProductDto>('/admin/products', {
        supplierId,
        kind: 'tour',
        countryAlpha2: 'VN',
        region: 'Phú Quốc',
        location: { lat: 10.587, lng: 103.957 },
        timeZone: 'Asia/Ho_Chi_Minh',
      })
    ).body;
    await adminPut(`/admin/products/${prodB.id}/translations/vi`, {
      title: 'Hành Trình Biển Xa 40km',
      slug: 'hanh-trinh-bien-xa-40km',
      summary: 'Khởi hành từ xa đảo ngọc.',
      description: 'Mô tả hành trình.',
    });
    await adminPut(`/admin/products/${prodB.id}/translations/en`, {
      title: 'Far Offshore Boat Adventure',
      slug: 'far-offshore-boat-adventure',
      summary: 'Deep sea day trip 40km away.',
      description: 'Detailed offshore boat adventure.',
    });
    await adminPost(`/admin/products/${prodB.id}/publish`);

    // AC3: Locale switching and per-locale slug lookup
    const viDetail = (await (
      await fetch(`${baseUrl}/catalog/products/vi/tour-dao-ngoc-bac-dao`)
    ).json()) as PublicCatalogProductDetail;
    expect(viDetail.title).toBe('Tour Đảo Ngọc Khám Phá Bắc Đảo');

    const enDetail = (await (
      await fetch(`${baseUrl}/catalog/products/en/north-phu-quoc-coastal-excursion`)
    ).json()) as PublicCatalogProductDetail;
    expect(enDetail.title).toBe('North Phu Quoc Coastal Excursion');

    // Cross-locale slug lookup returns 404
    const wrongLocaleSlug = await fetch(`${baseUrl}/catalog/products/en/tour-dao-ngoc-bac-dao`);
    expect(wrongLocaleSlug.status).toBe(404);

    // AC4: unaccent search 'dao ngoc' and 'đảo ngọc' both match in 'vi', while NOT matching in 'en'
    const resUnaccent = (await (
      await fetch(`${baseUrl}/catalog/products?locale=vi&q=${encodeURIComponent('dao ngoc')}`)
    ).json()) as PublicCatalogListResponse;
    expect(resUnaccent.items.map((i) => i.id)).toContain(prodA.id);

    const resAccented = (await (
      await fetch(`${baseUrl}/catalog/products?locale=vi&q=${encodeURIComponent('đảo ngọc')}`)
    ).json()) as PublicCatalogListResponse;
    expect(resAccented.items.map((i) => i.id)).toContain(prodA.id);

    const resWrongLang = (await (
      await fetch(`${baseUrl}/catalog/products?locale=en&q=${encodeURIComponent('dao ngoc')}`)
    ).json()) as PublicCatalogListResponse;
    expect(resWrongLang.items.map((i) => i.id)).not.toContain(prodA.id);
    expect(resWrongLang.items.map((i) => i.id)).not.toContain(prodB.id);

    // AC5: Geo radiusKm=10 around (10.2270, 103.9570) returns ONLY prodA (~3km), NOT prodB (~40km)
    const geoRes = (await (
      await fetch(`${baseUrl}/catalog/products?locale=en&near=10.2270,103.9570&radiusKm=10`)
    ).json()) as PublicCatalogListResponse;
    expect(geoRes.items.map((i) => i.id)).toEqual([prodA.id]);
    const expectedDist = haversineMeters(10.227, 103.957, 10.254, 103.957);
    const actualDist = geoRes.items[0]!.distanceMeters!;
    expect(Math.abs(actualDist - expectedDist) / expectedDist).toBeLessThan(0.01);
  });

  it('AC6: stable cursor pagination over 120 products with zero duplicates, zero gaps, and stability under concurrent inserts', async () => {
    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: 'Mass Catalog Supplier',
      countryAlpha2: 'VN',
    });
    const supplierId = sup.body.id;

    // Create & publish 120 products for a dedicated kind ('transfer') so existing tests do not pollute the count
    const createdIds: string[] = [];
    for (let i = 1; i <= 120; i++) {
      const created = await adminPost<AdminCatalogProductDto>('/admin/products', {
        supplierId,
        kind: 'transfer',
        countryAlpha2: 'VN',
        region: 'Phú Quốc',
        location: { lat: 10.1717, lng: 103.9912 },
        timeZone: 'Asia/Ho_Chi_Minh',
      });
      await adminPut(`/admin/products/${created.body.id}/translations/vi`, {
        title: `Xe Đưa Đón Tuyến ${i}`,
        slug: `xe-dua-don-tuyen-${i}`,
        summary: `Tóm tắt tuyến ${i}`,
        description: `Chi tiết tuyến ${i}`,
      });
      await adminPut(`/admin/products/${created.body.id}/translations/en`, {
        title: `Private Transfer Route ${i}`,
        slug: `private-transfer-route-${i}`,
        summary: `Summary route ${i}`,
        description: `Description route ${i}`,
      });
      await adminPost(`/admin/products/${created.body.id}/publish`);
      createdIds.push(created.body.id);
    }

    const collectedIds: string[] = [];
    let cursor: string | null = null;
    let pageNumber = 0;

    do {
      pageNumber++;
      const url = cursor
        ? `${baseUrl}/catalog/products?locale=en&kind=transfer&limit=25&cursor=${encodeURIComponent(cursor)}`
        : `${baseUrl}/catalog/products?locale=en&kind=transfer&limit=25`;
      const page = (await (await fetch(url)).json()) as PublicCatalogListResponse;

      for (const item of page.items) {
        collectedIds.push(item.id);
      }

      // After fetching page 1, concurrently insert & publish 3 new transfers
      if (pageNumber === 1) {
        for (let c = 1; c <= 3; c++) {
          const concurrent = await adminPost<AdminCatalogProductDto>('/admin/products', {
            supplierId,
            kind: 'transfer',
            countryAlpha2: 'VN',
            region: 'Phú Quốc',
            location: { lat: 10.18, lng: 103.99 },
            timeZone: 'Asia/Ho_Chi_Minh',
          });
          await adminPut(`/admin/products/${concurrent.body.id}/translations/vi`, {
            title: `Xe Mới Đồng Thời ${c}`,
            slug: `xe-moi-dong-thoi-${c}`,
            summary: `Tóm tắt mới ${c}`,
            description: `Chi tiết mới ${c}`,
          });
          await adminPut(`/admin/products/${concurrent.body.id}/translations/en`, {
            title: `Concurrent New Transfer ${c}`,
            slug: `concurrent-new-transfer-${c}`,
            summary: `Concurrent summary ${c}`,
            description: `Concurrent description ${c}`,
          });
          await adminPost(`/admin/products/${concurrent.body.id}/publish`);
        }
      }

      cursor = page.nextCursor;
    } while (cursor !== null);

    // Zero duplicates
    const uniqueIds = new Set(collectedIds);
    expect(uniqueIds.size).toBe(collectedIds.length);
    // Zero gaps: every single original 120 product was traversed cleanly
    expect(collectedIds.length).toBe(120);
    for (const origId of createdIds) {
      expect(uniqueIds.has(origId)).toBe(true);
    }
  }, 60_000);

  it('enforces max 20 https images per product and blocks dev fixtures in staging/production', async () => {
    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: 'Image Cap Supplier',
      countryAlpha2: 'VN',
    });
    const prod = (
      await adminPost<AdminCatalogProductDto>('/admin/products', {
        supplierId: sup.body.id,
        kind: 'activity',
        countryAlpha2: 'VN',
        region: 'Phú Quốc',
      })
    ).body;

    // 21 images -> 422
    const tooMany = Array.from({ length: 21 }, (_, idx) => ({
      url: `https://cdn.example.com/img-${idx}.jpg`,
      alt: { vi: `Anh ${idx}`, en: `Image ${idx}` },
    }));
    const resTooMany = await adminPut<Record<string, unknown>>(
      `/admin/products/${prod.id}/images`,
      { images: tooMany },
    );
    expect(resTooMany.status).toBe(422);
    expect(resTooMany.body['i18nKey']).toBe('catalog.images.tooMany');

    // http:// image -> 400
    const resInsecure = await adminPut<Record<string, unknown>>(
      `/admin/products/${prod.id}/images`,
      { images: [{ url: 'http://insecure.example.com/1.jpg', alt: { en: 'bad' } }] },
    );
    expect(resInsecure.status).toBe(400);
    expect(resInsecure.body['i18nKey']).toBe('catalog.images.invalidUrl');

    // Dev fixtures refuse staging & production, work in test/local
    const savedAppEnv = process.env['APP_ENV'];
    try {
      process.env['APP_ENV'] = 'staging';
      expect(() => assertFixturesAllowed()).toThrow(/APP_ENV=staging/);
      process.env['APP_ENV'] = 'production';
      expect(() => assertFixturesAllowed()).toThrow(/APP_ENV=production/);

      process.env['APP_ENV'] = 'test';
      const loaded = await seedCatalogDevFixtures(db);
      expect(loaded.productIds).toHaveLength(3);
    } finally {
      if (savedAppEnv === undefined) delete process.env['APP_ENV'];
      else process.env['APP_ENV'] = savedAppEnv;
    }
  });
});
