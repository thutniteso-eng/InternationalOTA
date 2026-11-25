import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDbClient, type DatabaseClient } from './client.ts';
import {
  IDENTITY_ROLES,
  type IdentityRole,
  identityUserRoles,
  identityUsers,
} from './schema/identity.ts';

export function isValidIdentityRole(role: string): role is IdentityRole {
  return (IDENTITY_ROLES as readonly string[]).includes(role);
}

/**
 * Grants a role to an existing user identified by email.
 * Idempotent: granting a role the user already has is a no-op.
 */
export async function grantRoleByEmail(
  db: DatabaseClient,
  email: string,
  role: string,
): Promise<{ userId: string; email: string; role: IdentityRole }> {
  if (!isValidIdentityRole(role)) {
    throw new Error(`Invalid role "${role}". Allowed roles: ${IDENTITY_ROLES.join(', ')}`);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: identityUsers.id, email: identityUsers.email })
    .from(identityUsers)
    .where(eq(identityUsers.email, normalizedEmail));

  if (!user) {
    throw new Error(`User with email "${normalizedEmail}" not found.`);
  }

  await db
    .insert(identityUserRoles)
    .values({
      userId: user.id,
      role,
    })
    .onConflictDoNothing();

  return { userId: user.id, email: user.email, role };
}

export async function runGrantRoleCli(args = process.argv.slice(2)): Promise<void> {
  const [email, role] = args;
  if (!email || !role) {
    console.error('Usage: pnpm identity:grant-role <email> <role>');
    console.error(`Allowed roles: ${IDENTITY_ROLES.join(', ')}`);
    process.exit(1);
  }

  const { db, pool } = createDbClient();
  try {
    const result = await grantRoleByEmail(db, email, role);
    console.log(`Granted role "${result.role}" to ${result.email} (userId=${result.userId}).`);
  } catch (err) {
    console.error('Failed to grant role:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runGrantRoleCli();
}
