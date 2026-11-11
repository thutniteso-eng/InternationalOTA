import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDbClient, type DatabaseClient } from './client.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getMigrationsFolder(): string {
  return resolve(__dirname, '../migrations');
}

export function assertCanMigrate(
  nodeEnv = process.env.NODE_ENV,
  allowProdMigrate = process.env.ALLOW_PROD_MIGRATE,
): void {
  if (nodeEnv === 'production' && allowProdMigrate !== '1') {
    throw new Error(
      'Refusing to run migrations in production without ALLOW_PROD_MIGRATE=1 (production migrations are a separate approved operation).',
    );
  }
}

export async function runMigrations(
  db: DatabaseClient,
  migrationsFolder = getMigrationsFolder(),
): Promise<void> {
  assertCanMigrate();
  await migrate(db, { migrationsFolder });
}

export async function runCli(): Promise<void> {
  try {
    assertCanMigrate();
    const { db, pool } = createDbClient();
    try {
      console.log('Running database migrations...');
      await runMigrations(db);
      console.log('Database migrations completed successfully.');
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCli();
}
