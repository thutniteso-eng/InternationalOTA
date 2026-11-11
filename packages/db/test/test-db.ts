import pg from 'pg';
import { createDbClient, type DbInstance } from '../src/client.ts';
import { runMigrations } from '../src/migrate.ts';

const { Pool } = pg;

export interface TestDbInstance extends DbInstance {
  dbName: string;
  testUrl: string;
  teardown: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDbInstance> {
  const defaultUrl =
    process.env.DATABASE_URL || 'postgresql://ota_user:ota_password@localhost:55432/ota_dev';

  const randomSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dbName = `ota_test_${randomSuffix}`;

  // Connect to default maintenance database to create test database
  const adminPool = new Pool({
    connectionString: defaultUrl,
  });

  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  // Connection URL for the new test database
  const testUrlParsed = new URL(defaultUrl);
  testUrlParsed.pathname = `/${dbName}`;
  const testUrl = testUrlParsed.toString();

  const { db, pool } = createDbClient({ connectionString: testUrl });

  // Run migrations
  await runMigrations(db);

  const teardown = async () => {
    await pool.end();

    const cleanupPool = new Pool({
      connectionString: defaultUrl,
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
