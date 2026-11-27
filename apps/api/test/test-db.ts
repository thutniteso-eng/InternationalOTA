import { createIsolatedTestDatabase, type TestDbInstance } from '@internationalota/db';

export type { TestDbInstance };

/**
 * Creates an isolated temporary PostgreSQL database for integration tests,
 * runs all forward-only migrations against it, and provides a teardown hook
 * that drops the temporary database without touching any shared database.
 *
 * Requires DATABASE_URL in the environment (no hard-coded credentials).
 */
export async function createTestDatabase(): Promise<TestDbInstance> {
  return createIsolatedTestDatabase({ requireEnvDatabaseUrl: true });
}
