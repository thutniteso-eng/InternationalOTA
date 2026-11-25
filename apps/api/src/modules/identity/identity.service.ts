import type { IncomingHttpHeaders } from 'node:http';
import {
  type DatabaseClient,
  identityAccounts,
  identityRateLimits,
  identitySessions,
  identityUserRoles,
  identityUsers,
  identityVerifications,
  isValidIdentityRole,
} from '@internationalota/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { EMAIL_SENDER, type EmailSender, LogOnlyEmailSender } from './email-sender.interface.js';
import { derivePrincipalKind, type Principal, type Role } from './identity.types.js';

const MIN_SECRET_LENGTH = 32;

function parseTrustedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function createAuthInstance(params: {
  db: DatabaseClient;
  secret: string;
  trustedOrigins: string[];
  isProduction: boolean;
  emailSender: EmailSender;
}) {
  return betterAuth({
    secret: params.secret,
    basePath: '/api/auth',
    trustedOrigins: params.trustedOrigins,
    database: drizzleAdapter(params.db, {
      provider: 'pg',
      schema: {
        user: identityUsers,
        session: identitySessions,
        account: identityAccounts,
        verification: identityVerifications,
        rateLimit: identityRateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        await params.emailSender.sendResetPasswordEmail({ to: user.email, url });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await params.emailSender.sendVerificationEmail({ to: user.email, url });
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': {
          window: 60,
          max: 5,
        },
        '/sign-up/email': {
          window: 60,
          max: 10,
        },
      },
    },
    advanced: {
      useSecureCookies: params.isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: params.isProduction,
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await params.db
              .insert(identityUserRoles)
              .values({
                userId: user.id,
                role: 'customer',
              })
              .onConflictDoNothing();
          },
        },
      },
    },
  });
}

/**
 * Internal wrapper around Better Auth (D-007).
 *
 * This is the ONLY file in the application allowed to import `better-auth`.
 * Nothing from `better-auth` is exposed in public method signatures.
 */
@Injectable()
export class IdentityService {
  private readonly auth: ReturnType<typeof createAuthInstance>;
  private readonly nodeHandler: ReturnType<typeof toNodeHandler>;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    @Optional() @Inject(EMAIL_SENDER) private readonly emailSender?: EmailSender,
  ) {
    const nodeEnv = process.env['NODE_ENV'] ?? 'development';
    const isProduction = nodeEnv === 'production';

    const secret = process.env['BETTER_AUTH_SECRET'];
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `BETTER_AUTH_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters long.`,
      );
    }

    if (isProduction && (!this.emailSender || this.emailSender instanceof LogOnlyEmailSender)) {
      throw new Error(
        'Refusing to start in production (NODE_ENV=production) without a real EmailSender configured.',
      );
    }

    const activeSender: EmailSender = this.emailSender ?? new LogOnlyEmailSender();
    const trustedOrigins = parseTrustedOrigins(process.env['AUTH_TRUSTED_ORIGINS']);

    this.auth = createAuthInstance({
      db: this.db,
      secret,
      trustedOrigins,
      isProduction,
      emailSender: activeSender,
    });

    this.nodeHandler = toNodeHandler(this.auth);
  }

  /**
   * Returns an Express request handler for `/api/auth/*` routes.
   * Must be mounted BEFORE `express.json()` so Better Auth reads the raw request stream.
   */
  getAuthHandler(): RequestHandler {
    return (req, res, next) => {
      void this.nodeHandler(req, res).catch(next);
    };
  }

  /**
   * Resolves the authenticated Principal from incoming request headers (session cookie),
   * enriching with roles from our own `identity.user_roles` table.
   */
  async resolvePrincipal(headers: IncomingHttpHeaders): Promise<Principal | null> {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });

    if (!session?.user?.id) {
      return null;
    }

    const userId = session.user.id;
    const roleRows = await this.db
      .select({ role: identityUserRoles.role })
      .from(identityUserRoles)
      .where(eq(identityUserRoles.userId, userId));

    const roles: Role[] = roleRows
      .map((row) => row.role)
      .filter((role): role is Role => isValidIdentityRole(role));

    return {
      userId,
      kind: derivePrincipalKind(roles),
      roles,
    };
  }
}
