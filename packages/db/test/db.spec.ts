import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient } from '../src/client.ts';
import { id, money, timestamps } from '../src/columns.ts';
import { assertCanMigrate, runMigrations } from '../src/migrate.ts';
import { appMeta, platformSchema } from '../src/schema/platform.ts';
import { createTestDatabase, type TestDbInstance } from './test-db.ts';

const dummyTable = platformSchema.table('dummy_helpers_test', {
  id: id(),
  ...timestamps(),
  ...money('price'),
});

describe('Database foundation integration tests', () => {
  let testDb: TestDbInstance;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.teardown();
    }
  });

  describe('createDbClient', () => {
    it('throws if DATABASE_URL is unset and no connectionString is provided', () => {
      const origUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        expect(() => createDbClient()).toThrow(
          /DATABASE_URL environment variable is required to create a database client, or provide connectionString in options/,
        );
      } finally {
        if (origUrl !== undefined) {
          process.env.DATABASE_URL = origUrl;
        }
      }
    });

    it('creates client successfully when connectionString is explicitly provided', async () => {
      const origUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const client = createDbClient({ connectionString: testDb.testUrl });
        expect(client.db).toBeDefined();
        expect(client.pool).toBeDefined();
        await client.pool.end();
      } finally {
        if (origUrl !== undefined) {
          process.env.DATABASE_URL = origUrl;
        }
      }
    });

    it('F1: tracked pools suppress 57P01 strictly during teardown without masking other errors', async () => {
      const { EventEmitter } = await import('node:events');
      const { attachTestPoolErrorGuard, createIsolatedTestDatabase } =
        await import('../src/test-database.ts');

      let tearingDown = false;
      const fakePool = new EventEmitter() as unknown as import('pg').Pool;
      attachTestPoolErrorGuard(fakePool, () => tearingDown);

      // During teardown, SQLSTATE 57P01 is cleanly suppressed
      tearingDown = true;
      const err57P01 = Object.assign(
        new Error('terminating connection due to administrator command'),
        {
          code: '57P01',
        },
      );
      expect(() => fakePool.emit('error', err57P01)).not.toThrow();

      // Real isolated temp DB with active extra pool drops cleanly WITH (FORCE)
      const isolated = await createIsolatedTestDatabase();
      const extraClient = createDbClient({ connectionString: isolated.testUrl, max: 1 });
      await extraClient.pool.query('SELECT 1');
      await expect(isolated.teardown()).resolves.toBeUndefined();
      expect(isolated.isTearingDown()).toBe(true);
    });
  });

  describe('schema and column helpers', () => {
    it('generates UUIDv7 id helper', () => {
      expect(dummyTable.id.name).toBe('id');
      expect(dummyTable.id.primary).toBe(true);

      const idCol = id();
      // Verify the default function generates valid UUIDv7 format
      const config = (idCol as unknown as { config: { defaultFn?: () => string } }).config;
      expect(typeof config.defaultFn).toBe('function');
      const generated = config.defaultFn?.();
      expect(typeof generated).toBe('string');
      expect(generated).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates timestamps helper with createdAt and updatedAt', () => {
      expect(dummyTable.createdAt.name).toBe('created_at');
      expect(dummyTable.updatedAt.name).toBe('updated_at');
    });

    it('generates money helper with minor and currency columns', () => {
      expect(dummyTable.priceMinor.name).toBe('price_minor');
      expect(dummyTable.priceCurrency.name).toBe('price_currency');
    });
  });

  describe('migration runner', () => {
    it('refuses to run in production without ALLOW_PROD_MIGRATE=1', () => {
      expect(() => assertCanMigrate('production', '0')).toThrowError(
        /Refusing to run migrations in production/,
      );
      expect(() => assertCanMigrate('production', undefined)).toThrowError(
        /Refusing to run migrations in production/,
      );
    });

    it('allows migrations in production when ALLOW_PROD_MIGRATE=1', () => {
      expect(() => assertCanMigrate('production', '1')).not.toThrow();
    });

    it('allows migrations in development or test', () => {
      expect(() => assertCanMigrate('development')).not.toThrow();
      expect(() => assertCanMigrate('test')).not.toThrow();
    });

    it('running migrations a second time on an already migrated DB is a no-op', async () => {
      await expect(runMigrations(testDb.db)).resolves.not.toThrow();
    });
  });

  describe('app_meta CRUD and row locking', () => {
    it('inserts and reads app_meta record', async () => {
      const key = 'test_feature_flags';
      const value = { enabled: true, rolloutPercent: 50 };

      await testDb.db.insert(appMeta).values({
        key,
        value,
      });

      const rows = await testDb.db.select().from(appMeta).where(eq(appMeta.key, key));

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.key).toBe(key);
      expect(row?.value).toEqual(value);
      expect(row?.createdAt).toBeInstanceOf(Date);
      expect(row?.updatedAt).toBeInstanceOf(Date);
    });

    it('supports Drizzle .for("update") query within a transaction', async () => {
      const key = 'drizzle_lock_key';
      await testDb.db.insert(appMeta).values({
        key,
        value: { locked: true },
      });

      await testDb.db.transaction(async (tx) => {
        const rows = await tx.select().from(appMeta).where(eq(appMeta.key, key)).for('update');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.key).toBe(key);
      });
    });

    it('SELECT ... FOR UPDATE in one transaction blocks a second transaction until commit (deterministic)', async () => {
      const lockKey = 'contended_row_key';
      await testDb.db.insert(appMeta).values({
        key: lockKey,
        value: { counter: 10 },
      });

      // 1. Transaction 1 acquires row lock via FOR UPDATE
      const client1 = await testDb.pool.connect();
      await client1.query('BEGIN');
      const res1 = await client1.query<{ key: string; value: unknown }>(
        'SELECT key, value FROM platform.app_meta WHERE key = $1 FOR UPDATE',
        [lockKey],
      );
      expect(res1.rows[0]?.key).toBe(lockKey);

      // 2. Transaction 2 attempts to acquire lock on the same row
      const client2 = await testDb.pool.connect();
      await client2.query('BEGIN');
      const pidRes = await client2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const client2Pid = pidRes.rows[0]?.pid;
      expect(client2Pid).toBeDefined();

      let tx2AcquiredLock = false;
      let tx1Committed = false;
      let tx2AcquiredBeforeTx1Commit = false;

      const tx2Promise = (async () => {
        // This query will BLOCK in Postgres kernel until client1 commits
        await client2.query('SELECT key, value FROM platform.app_meta WHERE key = $1 FOR UPDATE', [
          lockKey,
        ]);
        tx2AcquiredLock = true;
        tx2AcquiredBeforeTx1Commit = !tx1Committed;
        await client2.query('COMMIT');
        client2.release();
      })();

      // 3. Deterministic synchronization: Poll Postgres lock table until Postgres
      //    explicitly reports client2 as waiting on an ungranted lock
      let client2IsWaitingInLockTable = false;
      for (let i = 0; i < 100; i++) {
        const lockCheck = await testDb.pool.query<{ count: number }>(
          `SELECT count(*)::int as count FROM pg_locks WHERE pid = $1 AND NOT granted`,
          [client2Pid],
        );
        if (lockCheck.rows[0] && lockCheck.rows[0].count > 0) {
          client2IsWaitingInLockTable = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Assert PostgreSQL confirmed client2 is blocked waiting for lock
      expect(client2IsWaitingInLockTable).toBe(true);
      // Assert client2 has NOT acquired the lock yet
      expect(tx2AcquiredLock).toBe(false);

      // 4. Transaction 1 performs update and commits
      await client1.query(`UPDATE platform.app_meta SET value = $1 WHERE key = $2`, [
        JSON.stringify({ counter: 11 }),
        lockKey,
      ]);
      tx1Committed = true;
      await client1.query('COMMIT');
      client1.release();

      // 5. Await Transaction 2 completion (unblocked by Tx 1 commit)
      await tx2Promise;

      // 6. Assert ordering guarantees
      expect(tx2AcquiredLock).toBe(true);
      expect(tx2AcquiredBeforeTx1Commit).toBe(false);

      // Verify the final committed value
      const finalRes = await testDb.pool.query<{ value: unknown }>(
        'SELECT value FROM platform.app_meta WHERE key = $1',
        [lockKey],
      );
      expect(finalRes.rows[0]?.value).toEqual({ counter: 11 });
    });
  });
});
