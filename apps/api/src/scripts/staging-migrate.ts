import {
  applyRuntimeRoleGrants,
  createDbClient,
  runMigrations,
  seedReferenceData,
} from '@internationalota/db';
import { PgBoss } from 'pg-boss';
import {
  QUEUE_BOOKING_EXPIRY,
  QUEUE_IDEMPOTENCY_CLEANUP,
  QUEUE_INBOX_RELAY,
  QUEUE_OUTBOX_RELAY,
} from '../modules/messaging/index.js';

/**
 * One-shot staging/production database preparation script executed as `ota_owner`:
 * 1. Runs forward-only Drizzle migrations (with explicit `ALLOW_PROD_MIGRATE=1`).
 * 2. Seeds idempotent reference data & initial chart of accounts.
 * 3. Installs/migrates `pgboss` schema & pre-creates the application's queues so
 *    the runtime role (`ota_app`) never needs schema ownership or DDL privileges.
 * 4. Applies least-privilege runtime GRANTs to `ota_app`.
 */
async function main(): Promise<void> {
  const ownerUrl = process.env['OWNER_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!ownerUrl) {
    throw new Error('OWNER_DATABASE_URL (or DATABASE_URL) is required to run staging-migrate.');
  }

  const appRole = process.env['APP_DB_ROLE'] ?? 'ota_app';
  const { db, pool } = createDbClient({ connectionString: ownerUrl });

  try {
    process.env['ALLOW_PROD_MIGRATE'] = '1';
    process.stdout.write('Step 1/4: Running database migrations as ota_owner...\n');
    await runMigrations(db);

    process.stdout.write('Step 2/4: Seeding reference data and chart of accounts...\n');
    const seedResult = await seedReferenceData(db);
    process.stdout.write(
      `Seeded: ${seedResult.countries} countries, ${seedResult.currencies} currencies, ${seedResult.languages} languages, ${seedResult.timeZones} time zones, ${seedResult.accounts} accounts.\n`,
    );

    process.stdout.write('Step 3/4: Initializing pg-boss schema and queues as ota_owner...\n');
    const boss = new PgBoss({
      connectionString: ownerUrl,
      migrate: true,
      createSchema: true,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    try {
      await boss.createQueue(QUEUE_OUTBOX_RELAY);
      await boss.createQueue(QUEUE_INBOX_RELAY);
      await boss.createQueue(QUEUE_IDEMPOTENCY_CLEANUP);
      await boss.createQueue(QUEUE_BOOKING_EXPIRY);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }

    process.stdout.write(`Step 4/4: Applying least-privilege runtime grants to "${appRole}"...\n`);
    await applyRuntimeRoleGrants(db, appRole);

    process.stdout.write('Database migration, seed, pg-boss setup, and role grants completed.\n');
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `staging-migrate failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
