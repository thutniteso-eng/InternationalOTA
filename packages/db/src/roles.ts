import { sql } from 'drizzle-orm';
import type { DatabaseClient } from './client.ts';

const VALID_ROLE_REGEX = /^[a-z_][a-z0-9_]*$/;

function quoteIdent(ident: string): string {
  if (!VALID_ROLE_REGEX.test(ident)) {
    throw new Error(`Invalid PostgreSQL role identifier "${ident}".`);
  }
  return `"${ident}"`;
}

/**
 * Grants least-privilege runtime permissions to `appRole` (e.g. `ota_app`) after
 * `ota_owner` has executed migrations, seeds, and pg-boss schema setup.
 *
 * Security guarantees (P1-09):
 * - Zero schema/table ownership transferred to `appRole`.
 * - Zero DDL (`CREATE`, `ALTER`, `DROP`, `TRIGGER`) or `TRUNCATE` privileges granted.
 * - `reference` schema is read-only (`SELECT`) for the runtime role.
 * - `finance.journal_entries` & `finance.journal_lines` allow only `SELECT, INSERT` (no `UPDATE`, `DELETE`, `TRUNCATE`).
 * - `pgboss` schema: runtime receives `USAGE` on schema, `SELECT/INSERT/UPDATE/DELETE` on tables,
 *   `USAGE` on sequences, and `EXECUTE` on functions (`migrate: false` at API startup).
 */
export async function applyRuntimeRoleGrants(
  db: DatabaseClient,
  appRole = 'ota_app',
): Promise<void> {
  const roleIdent = quoteIdent(appRole);

  await db.execute(sql.raw(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${roleIdent};`));
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${roleIdent};`));

  await db.execute(
    sql.raw(
      `GRANT USAGE ON SCHEMA reference, identity, platform, finance, supply, catalog, inventory, pricing TO ${roleIdent};`,
    ),
  );
  await db.execute(sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA reference TO ${roleIdent};`));
  await db.execute(
    sql.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO ${roleIdent};`,
    ),
  );
  await db.execute(
    sql.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO ${roleIdent};`,
    ),
  );
  await db.execute(
    sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA supply TO ${roleIdent};`),
  );
  await db.execute(
    sql.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA catalog TO ${roleIdent};`,
    ),
  );
  await db.execute(
    sql.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA inventory TO ${roleIdent};`,
    ),
  );
  await db.execute(
    sql.raw(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA pricing TO ${roleIdent};`),
  );
  await db.execute(
    sql.raw(`GRANT SELECT, INSERT, UPDATE ON TABLE finance.accounts TO ${roleIdent};`),
  );
  await db.execute(
    sql.raw(
      `GRANT SELECT, INSERT ON TABLE finance.journal_entries, finance.journal_lines TO ${roleIdent};`,
    ),
  );
  await db.execute(
    sql.raw(
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA reference, identity, platform, finance, supply, catalog, inventory, pricing TO ${roleIdent};`,
    ),
  );
  await db.execute(
    sql.raw(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA finance, catalog, inventory, pricing TO ${roleIdent};`,
    ),
  );

  // Grant pgboss runtime permissions if pgboss schema has been installed
  const pgbossCheck = await db.execute(
    sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'`,
  );
  if (pgbossCheck.rows.length > 0) {
    await db.execute(sql.raw(`GRANT USAGE ON SCHEMA pgboss TO ${roleIdent};`));
    await db.execute(
      sql.raw(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${roleIdent};`,
      ),
    );
    await db.execute(sql.raw(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA pgboss TO ${roleIdent};`));
    await db.execute(sql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${roleIdent};`));
  }
}
