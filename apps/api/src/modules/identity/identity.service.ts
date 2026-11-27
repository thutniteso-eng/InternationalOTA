import type { IncomingHttpHeaders } from 'node:http';
import {
  type DatabaseClient,
  eq,
  identityAccounts,
  identityRateLimits,
  identitySessions,
  identityUserRoles,
  identityUsers,
  identityVerifications,
  isValidIdentityRole,
} from '@internationalota/db';
import { resolveAppEnv } from '@internationalota/shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
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

function parsePublicBaseUrl(raw: string | undefined): URL | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid PUBLIC_BASE_URL / BETTER_AUTH_URL: "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `PUBLIC_BASE_URL (or BETTER_AUTH_URL) must use http or https scheme, got "${parsed.protocol}".`,
    );
  }
  return parsed;
}

function createAuthInstance(params: {
  db: DatabaseClient;
  secret: string;
  baseURL?: string;
  trustedOrigins: string[];
  useSecureCookies: boolean;
  emailSender: EmailSender;
}) {
  return betterAuth({
    secret: params.secret,
    ...(params.baseURL ? { baseURL: params.baseURL } : {}),
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
      useSecureCookies: params.useSecureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: params.useSecureCookies,
      },
      // Read client IP exclusively from our internal trusted-proxy middleware header (L1),
      // never blindly from client-spoofable X-Forwarded-For or CF-Connecting-IP headers.
      ipAddress: {
        ipAddressHeaders: ['x-resolved-client-ip'],
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
  private readonly logger = new Logger(IdentityService.name);
  private readonly auth: ReturnType<typeof createAuthInstance>;
  private readonly nodeHandler: ReturnType<typeof toNodeHandler>;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    @Optional() @Inject(EMAIL_SENDER) private readonly emailSender?: EmailSender,
  ) {
    const appEnv = resolveAppEnv();

    const secret = process.env['BETTER_AUTH_SECRET'];
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `BETTER_AUTH_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters long.`,
      );
    }

    const usingLogOnlySender = !this.emailSender || this.emailSender instanceof LogOnlyEmailSender;
    if (appEnv === 'production' && usingLogOnlySender) {
      throw new Error(
        'Refusing to start in production (APP_ENV=production) without a real EmailSender configured.',
      );
    }
    if (appEnv === 'staging' && usingLogOnlySender) {
      this.logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'staging_log_only_email_sender',
          appEnv,
          message:
            'Starting in APP_ENV=staging with LogOnlyEmailSender; emails will be logged only and not delivered.',
        }),
      );
    }

    const publicBaseUrl = parsePublicBaseUrl(
      process.env['PUBLIC_BASE_URL'] ?? process.env['BETTER_AUTH_URL'],
    );
    const trustedOrigins = parseTrustedOrigins(process.env['AUTH_TRUSTED_ORIGINS']);

    // L2: outside local/test, fail fast without an explicit public base URL and non-empty AUTH_TRUSTED_ORIGINS
    if (appEnv !== 'local' && appEnv !== 'test') {
      if (!publicBaseUrl) {
        throw new Error(
          `PUBLIC_BASE_URL (or BETTER_AUTH_URL) must be explicitly configured when APP_ENV=${appEnv}.`,
        );
      }
      if (trustedOrigins.length === 0) {
        throw new Error(`AUTH_TRUSTED_ORIGINS must be non-empty when APP_ENV=${appEnv}.`);
      }
    }

    // L3: derive Secure cookie flag from public base URL scheme (https -> Secure), never from NODE_ENV
    const useSecureCookies = publicBaseUrl?.protocol === 'https:';

    const activeSender: EmailSender = this.emailSender ?? new LogOnlyEmailSender();

    this.auth = createAuthInstance({
      db: this.db,
      secret,
      ...(publicBaseUrl ? { baseURL: publicBaseUrl.origin } : {}),
      trustedOrigins,
      useSecureCookies,
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

  /**
   * Public D-018 check: returns true only when the user exists and has verified their email address.
   */
  async isEmailVerified(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ emailVerified: identityUsers.emailVerified })
      .from(identityUsers)
      .where(eq(identityUsers.id, userId))
      .limit(1);
    return row?.emailVerified === true;
  }
}
