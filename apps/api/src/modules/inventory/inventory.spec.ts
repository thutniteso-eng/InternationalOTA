import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDbClient,
  type DatabaseClient,
  grantRoleByEmail,
  seedReferenceData,
  sql,
} from '@internationalota/db';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { CatalogService } from '../catalog/index.js';
import type { SupplierRecord } from '../supply/index.js';
import { InventoryService } from './inventory.service.js';
import type {
  AdminDepartureDto,
  AdminDepartureListResponse,
  CancelDepartureResult,
  GenerateDeparturesResult,
  PublicAvailabilityResponse,
} from './inventory.types.js';

const TEST_AUTH_SECRET = 'p2-02-inventory-test-secret-at-least-32-characters';

function extractCookieHeader(res: Response): string {
  const setCookies = res.headers.getSetCookie();
  return setCookies.map((c) => c.split(';')[0]).join('; ');
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

function futureUtcDateString(daysAhead: number): string {
  const ms = Date.now() + daysAhead * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

describe('Inventory module integration tests (P2-02)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
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
  const nextIdemKey = () => `p2-02-key-${++idemSeq}`;

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

  async function adminGet<T>(path: string): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: adminCookie },
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function createPublishedTour(options: {
    namePrefix: string;
    slugSuffix: string;
    timeZone?: string;
    kind?: 'tour' | 'activity' | 'transfer';
    publish?: boolean;
  }): Promise<{ supplierId: string; productId: string }> {
    const sup = await adminPost<SupplierRecord>('/admin/suppliers', {
      name: `${options.namePrefix} Supplier`,
      countryAlpha2: 'VN',
    });
    expect(sup.status).toBe(201);

    const prod = await adminPost<{ id: string }>('/admin/products', {
      supplierId: sup.body.id,
      kind: options.kind ?? 'tour',
      countryAlpha2: 'VN',
      region: 'Phú Quốc',
      location: { lat: 10.22, lng: 103.96 },
      timeZone: options.timeZone ?? 'Asia/Ho_Chi_Minh',
    });
    expect(prod.status).toBe(201);

    if (options.publish !== false) {
      await adminPut(`/admin/products/${prod.body.id}/translations/vi`, {
        title: `Tour ${options.namePrefix}`,
        slug: `tour-${options.slugSuffix}`,
        summary: `Tóm tắt ${options.namePrefix}`,
        description: `Chi tiết ${options.namePrefix}`,
      });
      await adminPut(`/admin/products/${prod.body.id}/translations/en`, {
        title: `${options.namePrefix} Tour`,
        slug: `en-tour-${options.slugSuffix}`,
        summary: `Summary ${options.namePrefix}`,
        description: `Details ${options.namePrefix}`,
      });
      const pub = await adminPost(`/admin/products/${prod.body.id}/publish`);
      expect(pub.status).toBe(200);
    }

    return { supplierId: sup.body.id, productId: prod.body.id };
  }

  async function expectVerifyAllocatedClean() {
    const mismatchRes = await testDb.pool.query('SELECT * FROM inventory.verify_allocated()');
    expect(mismatchRes.rows).toHaveLength(0);
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
    inventoryService = moduleFixture.get(InventoryService);
    catalogService = moduleFixture.get(CatalogService);

    adminCookie = await signUpAndSignIn(
      'inventory-admin@example.com',
      'StrongPass123!',
      'Inventory Admin',
      '10.10.0.1',
      true,
    );
    customerCookie = await signUpAndSignIn(
      'inventory-customer@example.com',
      'StrongPass123!',
      'Inventory Customer',
      '10.10.0.2',
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

  it('AC1: Last seat — 50 concurrent allocate requests across 50 parallel DB connections yield 1 allocated and 49 sold_out', async () => {
    const { productId } = await createPublishedTour({
      namePrefix: 'AC1 Last Seat',
      slugSuffix: 'ac1-last-seat',
    });

    const targetDate = futureUtcDateString(5);
    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: targetDate,
        toDate: targetDate,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['09:00'],
        capacity: 1,
        bookingCutoffMinutes: 60,
      },
    );
    expect(gen.status).toBe(200);
    expect(gen.body.createdCount).toBe(1);
    const departureId = gen.body.createdIds[0]!;

    const concurrency = 50;
    const poolInstances = Array.from({ length: concurrency }, () =>
      createDbClient({ connectionString: testDb.testUrl, max: 1 }),
    );
    try {
      const pidRows = await Promise.all(
        poolInstances.map((inst) => inst.db.execute(sql`SELECT pg_backend_pid() AS pid`)),
      );
      const distinctPids = new Set(
        pidRows.map((r) => Number((r.rows[0] as Record<string, unknown>)['pid'])),
      );
      expect(distinctPids.size).toBe(concurrency);

      const barrier = createStartBarrier(concurrency);
      let inFlight = 0;
      let maxInFlight = 0;

      const results = await Promise.all(
        poolInstances.map(async (inst, idx) => {
          const svc = new InventoryService(inst.db, catalogService);
          await barrier();
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          try {
            return await svc.allocate({
              departureId,
              quantity: 1,
              refType: 'booking_hold',
              refId: `ac1-seat-${idx}`,
            });
          } finally {
            inFlight--;
          }
        }),
      );

      // Prove concurrent overlap before any completions
      expect(maxInFlight).toBe(concurrency);

      const allocated = results.filter((r) => r.status === 'allocated');
      const soldOut = results.filter((r) => r.status === 'sold_out');
      expect(allocated).toHaveLength(1);
      expect(soldOut).toHaveLength(49);

      const depRes = await testDb.pool.query<{ allocated: number; capacity: number }>(
        'SELECT allocated, capacity FROM inventory.departures WHERE id = $1::uuid',
        [departureId],
      );
      expect(depRes.rows[0]).toEqual({ allocated: 1, capacity: 1 });
      await expectVerifyAllocatedClean();
    } finally {
      await Promise.all(poolInstances.map((inst) => inst.pool.end()));
    }
  });

  it('AC2: Mixed load — 40 concurrent requests of qty 1..3 against capacity 10 never oversell and satisfy verify_allocated()', async () => {
    const { productId } = await createPublishedTour({
      namePrefix: 'AC2 Mixed Load',
      slugSuffix: 'ac2-mixed-load',
    });

    const targetDate = futureUtcDateString(6);
    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: targetDate,
        toDate: targetDate,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['10:00'],
        capacity: 10,
        bookingCutoffMinutes: 60,
      },
    );
    expect(gen.status).toBe(200);
    const departureId = gen.body.createdIds[0]!;

    const concurrency = 40;
    const poolInstances = Array.from({ length: concurrency }, () =>
      createDbClient({ connectionString: testDb.testUrl, max: 1 }),
    );
    try {
      await Promise.all(poolInstances.map((inst) => inst.db.execute(sql`SELECT 1`)));
      const barrier = createStartBarrier(concurrency);

      const results = await Promise.all(
        poolInstances.map(async (inst, idx) => {
          const svc = new InventoryService(inst.db, catalogService);
          const quantity = (idx % 3) + 1;
          await barrier();
          return svc.allocate({
            departureId,
            quantity,
            refType: 'booking_hold',
            refId: `ac2-hold-${idx}`,
          });
        }),
      );

      let grantedSum = 0;
      for (const res of results) {
        expect(['allocated', 'sold_out']).toContain(res.status);
        if (res.status === 'allocated') {
          grantedSum += res.allocation.quantity;
        }
      }

      expect(grantedSum).toBeGreaterThan(0);
      expect(grantedSum).toBeLessThanOrEqual(10);

      const depRes = await testDb.pool.query<{ allocated: number }>(
        'SELECT allocated FROM inventory.departures WHERE id = $1::uuid',
        [departureId],
      );
      expect(depRes.rows[0]?.allocated).toBe(grantedSum);
      await expectVerifyAllocatedClean();
    } finally {
      await Promise.all(poolInstances.map((inst) => inst.pool.end()));
    }
  });

  it('AC3: Idempotent concurrent same-ref allocation, quantity-conflict error, and double-release safety', async () => {
    const { productId } = await createPublishedTour({
      namePrefix: 'AC3 Idempotency',
      slugSuffix: 'ac3-idempotency',
    });

    const targetDate = futureUtcDateString(7);
    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: targetDate,
        toDate: targetDate,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['08:30'],
        capacity: 5,
      },
    );
    const departureId = gen.body.createdIds[0]!;

    // Two concurrent identical-ref allocations must produce 1 allocation row and increment once
    const poolA = createDbClient({ connectionString: testDb.testUrl, max: 1 });
    const poolB = createDbClient({ connectionString: testDb.testUrl, max: 1 });
    try {
      await Promise.all([poolA.db.execute(sql`SELECT 1`), poolB.db.execute(sql`SELECT 1`)]);
      const barrier = createStartBarrier(2);
      const [r1, r2] = await Promise.all([
        (async () => {
          await barrier();
          return new InventoryService(poolA.db, catalogService).allocate({
            departureId,
            quantity: 2,
            refType: 'booking',
            refId: 'idem-ref-1',
          });
        })(),
        (async () => {
          await barrier();
          return new InventoryService(poolB.db, catalogService).allocate({
            departureId,
            quantity: 2,
            refType: 'booking',
            refId: 'idem-ref-1',
          });
        })(),
      ]);

      expect(r1.status).toBe('allocated');
      expect(r2.status).toBe('allocated');
      if (r1.status === 'allocated' && r2.status === 'allocated') {
        expect(r1.allocation.id).toBe(r2.allocation.id);
      }
    } finally {
      await Promise.all([poolA.pool.end(), poolB.pool.end()]);
    }

    const rowAfterAlloc = await testDb.pool.query<{ allocated: number }>(
      'SELECT allocated FROM inventory.departures WHERE id = $1::uuid',
      [departureId],
    );
    expect(rowAfterAlloc.rows[0]?.allocated).toBe(2);

    // Same ref with different quantity -> typed ConflictException (409)
    await expect(
      inventoryService.allocate({
        departureId,
        quantity: 3,
        refType: 'booking',
        refId: 'idem-ref-1',
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Unknown ref release -> no-op success
    const unknownRelease = await inventoryService.release({
      departureId,
      refType: 'booking',
      refId: 'does-not-exist',
    });
    expect(unknownRelease).toEqual({ released: false, quantity: 0 });

    // Double release restores allocated only once
    const rel1 = await inventoryService.release({
      departureId,
      refType: 'booking',
      refId: 'idem-ref-1',
    });
    const rel2 = await inventoryService.release({
      departureId,
      refType: 'booking',
      refId: 'idem-ref-1',
    });
    expect(rel1).toEqual({ released: true, quantity: 2 });
    expect(rel2).toEqual({ released: false, quantity: 0 });

    const rowAfterRelease = await testDb.pool.query<{ allocated: number }>(
      'SELECT allocated FROM inventory.departures WHERE id = $1::uuid',
      [departureId],
    );
    expect(rowAfterRelease.rows[0]?.allocated).toBe(0);

    // Re-allocating an already-released ref -> typed error (409)
    await expect(
      inventoryService.allocate({
        departureId,
        quantity: 2,
        refType: 'booking',
        refId: 'idem-ref-1',
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expectVerifyAllocatedClean();
  });

  it('AC4: DB CHECK backstops reject invalid allocated/capacity updates (23514) and API rejects capacity below allocated (422)', async () => {
    const { productId } = await createPublishedTour({
      namePrefix: 'AC4 DB Backstop',
      slugSuffix: 'ac4-db-backstop',
    });

    const targetDate = futureUtcDateString(8);
    const gen = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: targetDate,
        toDate: targetDate,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        localTimes: ['11:00'],
        capacity: 5,
      },
    );
    const departureId = gen.body.createdIds[0]!;

    const alloc = await inventoryService.allocate({
      departureId,
      quantity: 3,
      refType: 'hold',
      refId: 'ac4-ref',
    });
    expect(alloc.status).toBe('allocated');

    // API rejects reducing capacity below allocated (3) -> 422 i18nKey
    const patchFail = await adminPatch<Record<string, unknown>>(
      `/admin/inventory/departures/${departureId}`,
      { capacity: 2 },
    );
    expect(patchFail.status).toBe(422);
    expect(patchFail.body['i18nKey']).toBe('inventory.departure.capacityBelowAllocated');

    // Reducing capacity down to exact allocated (3) is allowed -> 200
    const patchOk = await adminPatch<AdminDepartureDto>(
      `/admin/inventory/departures/${departureId}`,
      { capacity: 3 },
    );
    expect(patchOk.status).toBe(200);
    expect(patchOk.body.capacity).toBe(3);
    expect(patchOk.body.remaining).toBe(0);

    // Raw SQL backstops: allocated = capacity + 1, allocated = -1, capacity < allocated -> all fail with 23514
    for (const rawSql of [
      'UPDATE inventory.departures SET allocated = capacity + 1 WHERE id = $1::uuid',
      'UPDATE inventory.departures SET allocated = -1 WHERE id = $1::uuid',
      'UPDATE inventory.departures SET capacity = 2 WHERE id = $1::uuid',
    ]) {
      let pgCode: string | undefined;
      try {
        await testDb.pool.query(rawSql, [departureId]);
      } catch (err: unknown) {
        pgCode =
          typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
      }
      expect(pgCode).toBe('23514');
    }

    await expectVerifyAllocatedClean();
  });

  it('AC5: DB clock cutoff checks, closed/cancelled status outcomes, and not_found handling', async () => {
    const { productId } = await createPublishedTour({
      namePrefix: 'AC5 Cutoff Status',
      slugSuffix: 'ac5-cutoff-status',
    });

    // Unknown ID & malformed ID -> not_found
    expect(
      (
        await inventoryService.allocate({
          departureId: '01950000-0000-7000-8000-000000009999',
          quantity: 1,
          refType: 'hold',
          refId: 'unknown',
        })
      ).status,
    ).toBe('not_found');
    expect(
      (
        await inventoryService.allocate({
          departureId: 'not-a-uuid',
          quantity: 1,
          refType: 'hold',
          refId: 'bad-uuid',
        })
      ).status,
    ).toBe('not_found');

    // Create 4 departures anchored directly to PostgreSQL now() for precise DB-clock assertions
    const insertDep = async (offsetSql: string, cutoffMinutes: number, status = 'open') => {
      const res = await testDb.pool.query<{ id: string }>(
        `INSERT INTO inventory.departures
           (id, product_id, local_date, local_time, starts_at, capacity, status, booking_cutoff_minutes)
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           ((now() + ${offsetSql}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
           ((now() + ${offsetSql}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::time,
           now() + ${offsetSql},
           5,
           $2,
           $3
         )
         RETURNING id`,
        [productId, status, cutoffMinutes],
      );
      return res.rows[0]!.id;
    };

    const depIn30Min = await insertDep(`interval '30 minutes'`, 60, 'open');
    const depIn150Min = await insertDep(`interval '150 minutes'`, 60, 'open');
    const depClosed = await insertDep(`interval '2 days'`, 60, 'closed');
    const depCancelTarget = await insertDep(`interval '3 days'`, 60, 'open');

    // 30 min ahead with 60 min cutoff -> cutoff_passed
    expect(
      (
        await inventoryService.allocate({
          departureId: depIn30Min,
          quantity: 1,
          refType: 'hold',
          refId: 'ac5-30m',
        })
      ).status,
    ).toBe('cutoff_passed');

    // 150 min ahead with 60 min cutoff -> allocated (detects +2h clock shift mutation)
    expect(
      (
        await inventoryService.allocate({
          departureId: depIn150Min,
          quantity: 1,
          refType: 'hold',
          refId: 'ac5-150m',
        })
      ).status,
    ).toBe('allocated');

    // Closed -> closed
    expect(
      (
        await inventoryService.allocate({
          departureId: depClosed,
          quantity: 1,
          refType: 'hold',
          refId: 'ac5-closed',
        })
      ).status,
    ).toBe('closed');

    // Cancelled (even with existing allocation) returns activeAllocationsCount and subsequent allocate -> closed
    expect(
      (
        await inventoryService.allocate({
          departureId: depCancelTarget,
          quantity: 2,
          refType: 'hold',
          refId: 'ac5-before-cancel',
        })
      ).status,
    ).toBe('allocated');
    const cancelRes = await adminPost<CancelDepartureResult>(
      `/admin/inventory/departures/${depCancelTarget}/cancel`,
    );
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.departure.status).toBe('cancelled');
    expect(cancelRes.body.activeAllocationsCount).toBe(1);

    expect(
      (
        await inventoryService.allocate({
          departureId: depCancelTarget,
          quantity: 1,
          refType: 'hold',
          refId: 'ac5-after-cancel',
        })
      ).status,
    ).toBe('closed');

    const reopenCancelled = await adminPost<Record<string, unknown>>(
      `/admin/inventory/departures/${depCancelTarget}/reopen`,
    );
    expect(reopenCancelled.status).toBe(422);
    expect(reopenCancelled.body['i18nKey']).toBe('inventory.departure.alreadyCancelled');

    await expectVerifyAllocatedClean();
  });

  it('AC6: Time zone conversion via PostgreSQL AT TIME ZONE and DST non-existent local time rejection (422)', async () => {
    const vnTour = await createPublishedTour({
      namePrefix: 'AC6 VN TZ',
      slugSuffix: 'ac6-vn-tz',
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    const genVn = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${vnTour.productId}/departures/generate`,
      {
        fromDate: '2026-12-20',
        toDate: '2026-12-20',
        weekdays: [7], // 2026-12-20 is Sunday
        localTimes: ['08:00'],
        capacity: 15,
      },
    );
    expect(genVn.status).toBe(200);
    expect(genVn.body.createdCount).toBe(1);

    const listVn = await adminGet<AdminDepartureListResponse>(
      `/admin/inventory/products/${vnTour.productId}/departures?from=2026-12-20&to=2026-12-20`,
    );
    expect(listVn.status).toBe(200);
    expect(listVn.body.items[0]?.startsAt).toBe('2026-12-20T01:00:00.000Z');

    // Europe/Berlin DST spring-forward on 2027-03-28: clocks jump 02:00 -> 03:00 (02:30 does not exist)
    const berlinTour = await createPublishedTour({
      namePrefix: 'AC6 Berlin DST',
      slugSuffix: 'ac6-berlin-dst',
      timeZone: 'Europe/Berlin',
    });

    const genDstGap = await adminPost<Record<string, unknown>>(
      `/admin/inventory/products/${berlinTour.productId}/departures/generate`,
      {
        fromDate: '2027-03-28',
        toDate: '2027-03-28',
        weekdays: [7], // Sunday
        localTimes: ['02:30'],
        capacity: 10,
      },
    );
    expect(genDstGap.status).toBe(422);
    expect(genDstGap.body['i18nKey']).toBe('inventory.departure.nonExistentLocalTime');

    // Nothing committed on rejected batch
    const listBerlinAfterReject = await adminGet<AdminDepartureListResponse>(
      `/admin/inventory/products/${berlinTour.productId}/departures`,
    );
    expect(listBerlinAfterReject.body.items).toHaveLength(0);

    // Valid pre-transition (01:30 CET = 00:30Z) and post-transition (03:30 CEST = 01:30Z) succeed
    const genValid = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${berlinTour.productId}/departures/generate`,
      {
        fromDate: '2027-03-28',
        toDate: '2027-03-28',
        weekdays: [7],
        localTimes: ['01:30', '03:30'],
        capacity: 10,
      },
    );
    expect(genValid.status).toBe(200);
    expect(genValid.body.createdCount).toBe(2);

    const listBerlin = await adminGet<AdminDepartureListResponse>(
      `/admin/inventory/products/${berlinTour.productId}/departures`,
    );
    expect(listBerlin.body.items.map((i) => i.startsAt)).toEqual([
      '2027-03-28T00:30:00.000Z',
      '2027-03-28T01:30:00.000Z',
    ]);
  });

  it('AC7: Re-running schedule rule creates 0 duplicates, preserves allocations, enforces 366-day limit, and rejects transfers', async () => {
    const { productId } = await createPublishedTour({
      namePrefix: 'AC7 Schedule Rule',
      slugSuffix: 'ac7-schedule-rule',
    });

    const rule = {
      fromDate: '2027-05-01',
      toDate: '2027-05-07',
      weekdays: [1, 3, 5, 6, 7],
      localTimes: ['08:00', '14:00'],
      capacity: 20,
      bookingCutoffMinutes: 60,
    };

    const run1 = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      rule,
    );
    expect(run1.status).toBe(200);
    expect(run1.body.createdCount).toBe(10); // 5 matching days * 2 times
    expect(run1.body.skippedCount).toBe(0);

    // Allocate seats on one departure
    const depId = run1.body.createdIds[0]!;
    const alloc = await inventoryService.allocate({
      departureId: depId,
      quantity: 4,
      refType: 'hold',
      refId: 'ac7-preserve',
    });
    expect(alloc.status).toBe('allocated');

    // Second run with overlapping rule + different capacity leaves existing departures & allocations intact
    const run2 = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      { ...rule, capacity: 99 },
    );
    expect(run2.status).toBe(200);
    expect(run2.body.createdCount).toBe(0);
    expect(run2.body.skippedCount).toBe(10);

    const listAfter = await adminGet<AdminDepartureListResponse>(
      `/admin/inventory/products/${productId}/departures`,
    );
    const preserved = listAfter.body.items.find((d) => d.id === depId);
    expect(preserved?.capacity).toBe(20);
    expect(preserved?.allocated).toBe(4);

    // 367-day range rejected -> 400
    const over366 = await adminPost<Record<string, unknown>>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        ...rule,
        fromDate: '2028-01-01',
        toDate: '2029-01-01', // 2028 is leap year -> 367 days inclusive
      },
    );
    expect(over366.status).toBe(400);

    // 366-day leap range allowed (single day/weekday across whole leap year)
    const exact366 = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      {
        fromDate: '2028-01-01',
        toDate: '2028-12-31',
        weekdays: [6],
        localTimes: ['08:00'],
        capacity: 10,
      },
    );
    expect(exact366.status).toBe(200);
    expect(exact366.body.createdCount).toBeGreaterThan(50);

    // Transfer product rejected with 422 i18nKey
    const transfer = await createPublishedTour({
      namePrefix: 'AC7 Transfer',
      slugSuffix: 'ac7-transfer',
      kind: 'transfer',
    });
    const transferRes = await adminPost<Record<string, unknown>>(
      `/admin/inventory/products/${transfer.productId}/departures/generate`,
      rule,
    );
    expect(transferRes.status).toBe(422);
    expect(transferRes.body['i18nKey']).toBe('inventory.product.unsupportedKind');
  });

  it('AC8: Public availability hides draft/archived/suspended products (404), hides past/cutoff/closed/cancelled departures, updates remaining, and leaks no allocation refs', async () => {
    const draft = await createPublishedTour({
      namePrefix: 'AC8 Draft',
      slugSuffix: 'ac8-draft',
      publish: false,
    });
    const archived = await createPublishedTour({
      namePrefix: 'AC8 Archived',
      slugSuffix: 'ac8-archived',
    });
    await adminPost(`/admin/products/${archived.productId}/archive`);

    const susp = await createPublishedTour({
      namePrefix: 'AC8 Suspended Sup',
      slugSuffix: 'ac8-suspended',
    });
    await adminPost(`/admin/suppliers/${susp.supplierId}/suspend`);

    const from = futureUtcDateString(0);
    const to = futureUtcDateString(10);

    for (const hiddenId of [
      draft.productId,
      archived.productId,
      susp.productId,
      '01950000-0000-7000-8000-000000000404',
    ]) {
      const hiddenRes = await fetch(
        `${baseUrl}/catalog/products/${hiddenId}/availability?from=${from}&to=${to}`,
      );
      expect(hiddenRes.status).toBe(404);
    }

    // Window > 62 days -> 400
    const visible = await createPublishedTour({
      namePrefix: 'AC8 Visible Tour',
      slugSuffix: 'ac8-visible',
    });
    const over62 = await fetch(
      `${baseUrl}/catalog/products/${visible.productId}/availability?from=2027-01-01&to=2027-03-10`,
    );
    expect(over62.status).toBe(400);

    // Seed future open, future sold-out, past, cutoff-passed, closed, cancelled departures directly cleanly
    const seedDep = async (offsetSql: string, capacity: number, status = 'open', cutoff = 60) => {
      const res = await testDb.pool.query<{ id: string }>(
        `INSERT INTO inventory.departures
           (id, product_id, local_date, local_time, starts_at, capacity, status, booking_cutoff_minutes)
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           ((now() + ${offsetSql}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
           date_trunc('second', ((now() + ${offsetSql}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::time),
           now() + ${offsetSql},
           $2,
           $3,
           $4
         )
         RETURNING id`,
        [visible.productId, capacity, status, cutoff],
      );
      return res.rows[0]!.id;
    };

    const depOpenAvail = await seedDep(`interval '2 days'`, 5, 'open', 60);
    const depOpenSoldOut = await seedDep(`interval '3 days'`, 2, 'open', 60);
    await seedDep(`interval '-2 hours'`, 5, 'open', 60); // past -> hidden
    await seedDep(`interval '20 minutes'`, 5, 'open', 60); // cutoff passed -> hidden
    await seedDep(`interval '4 days'`, 5, 'closed', 60); // closed -> hidden
    await seedDep(`interval '5 days'`, 5, 'cancelled', 60); // cancelled -> hidden

    await inventoryService.allocate({
      departureId: depOpenAvail,
      quantity: 2,
      refType: 'secret_hold_type',
      refId: 'SECRET_ALLOC_REF_DO_NOT_LEAK',
    });
    await inventoryService.allocate({
      departureId: depOpenSoldOut,
      quantity: 2,
      refType: 'secret_hold_type',
      refId: 'SECRET_SOLDOUT_REF',
    });

    const pubRes = await fetch(
      `${baseUrl}/catalog/products/${visible.productId}/availability?from=${from}&to=${to}`,
    );
    expect(pubRes.status).toBe(200);
    const rawText = await pubRes.text();
    expect(rawText).not.toContain('refId');
    expect(rawText).not.toContain('refType');
    expect(rawText).not.toContain('SECRET_ALLOC_REF_DO_NOT_LEAK');
    expect(rawText).not.toContain('allocated');

    const parsed = JSON.parse(rawText) as PublicAvailabilityResponse;
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      id: depOpenAvail,
      remaining: 3,
      status: 'available',
    });
    expect(parsed.items[1]).toMatchObject({
      id: depOpenSoldOut,
      remaining: 0,
      status: 'sold_out',
    });
  });

  it('AC9 & write-isolation invariant: auth guards (401/403), @Idempotent replay, and allocated column is written only inside inventory module', async () => {
    const { productId } = await createPublishedTour({
      namePrefix: 'AC9 Auth Idem',
      slugSuffix: 'ac9-auth-idem',
    });

    const body = {
      fromDate: '2027-06-01',
      toDate: '2027-06-03',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      localTimes: ['09:00'],
      capacity: 12,
    };

    const anon = await fetch(
      `${baseUrl}/admin/inventory/products/${productId}/departures/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': nextIdemKey() },
        body: JSON.stringify(body),
      },
    );
    expect(anon.status).toBe(401);

    const cust = await fetch(
      `${baseUrl}/admin/inventory/products/${productId}/departures/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: customerCookie,
          'Idempotency-Key': nextIdemKey(),
        },
        body: JSON.stringify(body),
      },
    );
    expect(cust.status).toBe(403);

    const idemKey = nextIdemKey();
    const first = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      body,
      idemKey,
    );
    const replay = await adminPost<GenerateDeparturesResult>(
      `/admin/inventory/products/${productId}/departures/generate`,
      body,
      idemKey,
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(first.body.createdCount).toBe(3);

    // Static guard (Scope B): no source file outside apps/api/src/modules/inventory may write inventory.departures.allocated
    const modulesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    const scanDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'inventory') {
            scanDir(full);
          }
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const content = readFileSync(full, 'utf8');
          if (
            /inventory\.departures|inventoryDepartures/.test(content) &&
            /allocated/.test(content)
          ) {
            offenders.push(full);
          }
        }
      }
    };
    scanDir(modulesRoot);
    expect(offenders).toEqual([]);
  });
});
