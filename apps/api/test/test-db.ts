import { createDbClient, type DbInstance, runMigrations } from '@internationalota/db';
import pg from 'pg';

const { Pool } = pg;

export interface TestDbInstance extends DbInstance {
  dbName: string;
  testUrl: string;
  teardown: () => Promise<void>;
}

/**
 * Creates an isolated temporary PostgreSQL database for integration tests,
 * runs all forward-only migrations against it, and provides a teardown hook
 * that drops the temporary database without touching any shared database.
 *
 * Requires DATABASE_URL in the environment (no hard-coded credentials).
 */
export async function createTestDatabase(): Promise<TestDbInstance> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required to create an isolated test database.',
    );
  }

  const randomSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dbName = `ota_test_${randomSuffix}`;

  const adminPool = new Pool({
    connectionString: adminUrl,
  });

  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  const testUrlParsed = new URL(adminUrl);
  testUrlParsed.pathname = `/${dbName}`;
  const testUrl = testUrlParsed.toString();

  const { db, pool } = createDbClient({ connectionString: testUrl });

  await runMigrations(db);

  const teardown = async (): Promise<void> => {
    await pool.end();

    const cleanupPool = new Pool({
      connectionString: adminUrl,
    });

    try {
      await cleanupPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await cleanupPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await cleanupPool.end();
    }
  };

  return {
    db,
    pool,
    dbName,
    testUrl,
    teardown,
  };
}
