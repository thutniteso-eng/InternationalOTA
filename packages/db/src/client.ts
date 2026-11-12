import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

const { Pool } = pg;
export { Pool };

export type DatabaseSchema = typeof schema;
export type DatabaseClient = NodePgDatabase<DatabaseSchema>;

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

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL environment variable is required to create a database client, or provide connectionString in options',
    );
  }

  const pool =
    options.pool ??
    new Pool({
      connectionString,
      max: options.max ?? 10,
    });

  const db = drizzle(pool, { schema });
  return { db, pool };
}
