import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDbClient,
  type DatabaseClient,
  eq,
  identityUserRoles,
  identityUsers,
  opsAdminAudit,
  uuidv7,
} from '@internationalota/db';
import { type AppEnv, resolveAppEnv } from '@internationalota/shared';

export const ALLOWED_ADMIN_GRANT_ROLES = ['admin', 'operator'] as const;
export type AllowedAdminGrantRole = (typeof ALLOWED_ADMIN_GRANT_ROLES)[number];

export interface AdminGrantArgs {
  readonly email: string;
  readonly role: AllowedAdminGrantRole;
}

export interface AdminGrantResult {
  readonly userId: string;
  readonly email: string;
  readonly role: AllowedAdminGrantRole;
  readonly auditId: string;
  readonly appEnv: AppEnv;
}

export class AdminGrantProductionForbiddenError extends Error {
  constructor() {
    super(
      [
        'Refusing to run admin:grant in APP_ENV=production.',
        'Production role grants must follow the documented SQL runbook instead of CLI scripts:',
        '  BEGIN;',
        "  INSERT INTO identity.user_roles (user_id, role) SELECT id, 'admin' FROM identity.\"user\" WHERE email = '<email>' ON CONFLICT DO NOTHING;",
        "  INSERT INTO ops.admin_audit (id, actor_user_id, action, target_type, target_id, reason) VALUES (gen_random_uuid(), 'runbook:<operator>', 'admin_role_grant', 'user_role', '<user_id>:admin', '<ticket_ref>');",
        '  COMMIT;',
      ].join('\n'),
    );
    this.name = 'AdminGrantProductionForbiddenError';
  }
}

export function parseAdminGrantCliArgs(rawArgs: readonly string[]): AdminGrantArgs {
  const args = rawArgs.filter((arg, index) => !(index === 0 && arg === '--'));
  let email: string | undefined;
  let role: string = 'admin';

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--role') {
      const next = args[i + 1];
      if (!next) {
        throw new Error('Missing value for --role (expected admin or operator).');
      }
      role = next;
      i++;
    } else if (token.startsWith('--role=')) {
      role = token.slice('--role='.length);
    } else if (token.startsWith('-')) {
      throw new Error(`Unknown option "${token}".`);
    } else if (!email) {
      email = token;
    } else {
      throw new Error(`Unexpected extra argument "${token}".`);
    }
  }

  if (!email) {
    throw new Error('Usage: pnpm admin:grant <email> [--role admin|operator]');
  }
  if (!(ALLOWED_ADMIN_GRANT_ROLES as readonly string[]).includes(role)) {
    throw new Error(
      `Invalid role "${role}" for admin:grant. Allowed roles: ${ALLOWED_ADMIN_GRANT_ROLES.join(', ')}.`,
    );
  }

  return {
    email: email.trim().toLowerCase(),
    role: role as AllowedAdminGrantRole,
  };
}

export async function runAdminGrant(
  db: DatabaseClient,
  input: {
    readonly email: string;
    readonly role: AllowedAdminGrantRole;
    readonly actor?: string;
    readonly appEnv?: AppEnv;
  },
): Promise<AdminGrantResult> {
  const appEnv = input.appEnv ?? resolveAppEnv();
  if (appEnv === 'production') {
    throw new AdminGrantProductionForbiddenError();
  }

  const normalizedEmail = input.email.trim().toLowerCase();
  const actor = input.actor ?? `cli:${userInfo().username || 'operator'}`;

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: identityUsers.id, email: identityUsers.email })
      .from(identityUsers)
      .where(eq(identityUsers.email, normalizedEmail))
      .limit(1);

    if (!user) {
      throw new Error(`User with email "${normalizedEmail}" not found.`);
    }

    await tx
      .insert(identityUserRoles)
      .values({
        userId: user.id,
        role: input.role,
      })
      .onConflictDoNothing();

    const auditId = uuidv7();
    await tx.insert(opsAdminAudit).values({
      id: auditId,
      actorUserId: actor,
      action: 'admin_role_grant',
      targetType: 'user_role',
      targetId: `${user.id}:${input.role}`,
      reason: `Granted role ${input.role} via admin:grant (${appEnv})`,
      requestId: null,
    });

    return {
      userId: user.id,
      email: user.email,
      role: input.role,
      auditId,
      appEnv,
    };
  });
}

export async function main(rawArgs = process.argv.slice(2)): Promise<void> {
  const appEnv = resolveAppEnv();
  if (appEnv === 'production') {
    process.stderr.write(`${new AdminGrantProductionForbiddenError().message}\n`);
    process.exit(1);
  }

  let parsed: AdminGrantArgs;
  try {
    parsed = parseAdminGrantCliArgs(rawArgs);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const { db, pool } = createDbClient();
  try {
    const res = await runAdminGrant(db, {
      email: parsed.email,
      role: parsed.role,
      appEnv,
    });
    process.stdout.write(
      `${JSON.stringify({
        granted: true,
        userId: res.userId,
        email: res.email,
        role: res.role,
        auditId: res.auditId,
        appEnv: res.appEnv,
      })}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `admin:grant failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
