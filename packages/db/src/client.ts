import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

const { Pool } = pg;
export { Pool };

export type DatabaseSchema = typeof schema;
export type DatabaseClient = NodePgDatabase<DatabaseSchema>;
export type DatabaseTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export type PoolCreatedHook = (pool: pg.Pool, connectionString: string) => void;

const poolCreatedHooks = new Set<PoolCreatedHook>();

/**
 * Registers an observer notified whenever `createDbClient` instantiates a new `pg.Pool`.
 * Returns an unsubscribe callback (used by isolated test database harnesses to track and
 * cleanly close all pools created during a test run).
 */
export function registerPoolCreatedHook(hook: PoolCreatedHook): () => void {
  poolCreatedHooks.add(hook);
  return () => {
    poolCreatedHooks.delete(hook);
  };
}

export interface CreateDbClientOptions {
  connectionString?: string;
  max?: number;
  pool?: pg.Pool;
}

export interface DbInstance {
  db: DatabaseClient;
  pool: pg.Pool;
}

export function createDbClient(options: CreateDbClientOptions = {}): DbInstance {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString && !options.pool) {
    throw new Error(
      'DATABASE_URL environment variable is required to create a database client, or provide connectionString in options',
    );
  }

  let pool: pg.Pool;
  if (options.pool) {
    pool = options.pool;
  } else {
    pool = new Pool({
      connectionString: connectionString!,
      max: options.max ?? 10,
    });
    for (const hook of poolCreatedHooks) {
      hook(pool, connectionString!);
    }
  }

  const db = drizzle(pool, { schema });
  return { db, pool };
}
