import pg from 'pg';
import { createDbClient, registerPoolCreatedHook, type DbInstance } from './client.ts';
import { runMigrations } from './migrate.ts';

const { Pool } = pg;

const PG_ADMIN_TERMINATED = '57P01';

export interface ClosableApp {
  close: () => Promise<void>;
}

export interface ClosableClient {
  end: () => Promise<unknown>;
}

export interface TestDbInstance extends DbInstance {
  dbName: string;
  testUrl: string;
  registerPool: <T extends pg.Pool>(pool: T) => T;
  registerClient: <T extends ClosableClient>(client: T) => T;
  registerApp: <T extends ClosableApp>(app: T) => T;
  isTearingDown: () => boolean;
  teardown: () => Promise<void>;
}

function extractDbName(connectionString: string): string | null {
  try {
    const parsed = new URL(connectionString);
    return parsed.pathname.replace(/^\/+/, '') || null;
  } catch {
    return null;
  }
}

function isPgTerminatedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_ADMIN_TERMINATED
  );
}

/**
 * Attaches an `'error'` listener that suppresses PostgreSQL `57P01` ("terminating connection
 * due to administrator command") strictly while `isTearingDown()` is true, and re-throws any
 * other error loudly so unexpected pool failures never go silent.
 */
export function attachTestPoolErrorGuard(pool: pg.Pool, isTearingDown: () => boolean): void {
  pool.on('error', (err: Error) => {
    if (isTearingDown() && isPgTerminatedError(err)) {
      return;
    }
    setImmediate(() => {
      throw err;
    });
  });
}

async function endPoolSafely(pool: pg.Pool): Promise<void> {
  if (pool.ended || pool.ending) {
    return;
  }
  await pool.end();
}

/**
 * Creates an isolated temporary PostgreSQL database for integration tests, runs forward-only
 * migrations, automatically tracks every pool opened against that temp DB, and performs ordered
 * teardown (apps -> clients -> pools -> pg_terminate_backend -> DROP DATABASE WITH (FORCE)) with
 * a `57P01` error guard active strictly during teardown.
 */
export async function createIsolatedTestDatabase(options?: {
  readonly defaultUrl?: string;
  readonly requireEnvDatabaseUrl?: boolean;
}): Promise<TestDbInstance> {
  const envUrl = process.env['DATABASE_URL'];
  const adminUrl = options?.requireEnvDatabaseUrl
    ? envUrl
    : (envUrl ??
      options?.defaultUrl ??
      'postgresql://ota_user:ota_password@localhost:55432/ota_dev');

  if (!adminUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required to create an isolated test database.',
    );
  }

  const randomSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dbName = `ota_test_${randomSuffix}`;

  const adminPool = new Pool({ connectionString: adminUrl });
  attachTestPoolErrorGuard(adminPool, () => false);
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await endPoolSafely(adminPool);
  }

  const testUrlParsed = new URL(adminUrl);
  testUrlParsed.pathname = `/${dbName}`;
  const testUrl = testUrlParsed.toString();

  let tearingDown = false;
  let teardownPromise: Promise<void> | null = null;
  const registeredPools = new Set<pg.Pool>();
  const registeredClients = new Set<ClosableClient>();
  const registeredApps = new Set<ClosableApp>();

  const registerPool = <T extends pg.Pool>(targetPool: T): T => {
    if (!registeredPools.has(targetPool)) {
      registeredPools.add(targetPool);
      attachTestPoolErrorGuard(targetPool, () => tearingDown);
    }
    return targetPool;
  };

  const registerClient = <T extends ClosableClient>(client: T): T => {
    registeredClients.add(client);
    return client;
  };

  const registerApp = <T extends ClosableApp>(app: T): T => {
    registeredApps.add(app);
    return app;
  };

  const unsubscribeHook = registerPoolCreatedHook((createdPool, connStr) => {
    if (extractDbName(connStr) === dbName) {
      registerPool(createdPool);
    }
  });

  const { db, pool } = createDbClient({ connectionString: testUrl });
  registerPool(pool);

  try {
    await runMigrations(db);
  } catch (err) {
    tearingDown = true;
    unsubscribeHook();
    await Promise.allSettled([...registeredPools].map((p) => endPoolSafely(p)));
    const failCleanupPool = new Pool({ connectionString: adminUrl });
    attachTestPoolErrorGuard(failCleanupPool, () => true);
    try {
      await failCleanupPool
        .query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
        .catch(() => undefined);
    } finally {
      await endPoolSafely(failCleanupPool);
    }
    throw err;
  }

  const teardown = (): Promise<void> => {
    if (teardownPromise) {
      return teardownPromise;
    }
    teardownPromise = (async () => {
      tearingDown = true;
      unsubscribeHook();

      for (const app of [...registeredApps]) {
        await app.close().catch(() => undefined);
      }

      await Promise.allSettled([...registeredClients].map((c) => c.end()));
      await Promise.allSettled([...registeredPools].map((p) => endPoolSafely(p)));

      const cleanupPool = new Pool({ connectionString: adminUrl });
      attachTestPoolErrorGuard(cleanupPool, () => true);

      try {
        await cleanupPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await cleanupPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await endPoolSafely(cleanupPool);
      }
    })();

    return teardownPromise;
  };

  return {
    db,
    pool,
    dbName,
    testUrl,
    registerPool,
    registerClient,
    registerApp,
    isTearingDown: () => tearingDown,
    teardown,
  };
}
