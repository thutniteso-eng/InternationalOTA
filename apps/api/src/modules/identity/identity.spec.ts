import {
  type DatabaseClient,
  eq,
  grantRoleByEmail,
  idempotencyKeys,
  identityAccounts,
  identityRateLimits,
  identitySessions,
  identityUserRoles,
  identityUsers,
  sql,
} from '@internationalota/db';
import { type INestApplication, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../../../test/test-db.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { EMAIL_SENDER, type EmailSender } from './email-sender.interface.js';
import { IdentityService } from './identity.service.js';
import type { Principal } from './identity.types.js';

const TEST_AUTH_SECRET = 'p1-06-identity-test-secret-key-at-least-32-chars';

function extractCookieHeader(res: Response): string {
  const setCookies = res.headers.getSetCookie();
  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function createConfiguredTestApp(): Promise<{
  app: INestApplication;
  baseUrl: string;
  db: DatabaseClient;
}> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.listen(0);
  const baseUrl = await app.getUrl();
  const db = moduleFixture.get<DatabaseClient>(DRIZZLE_DB);
  return { app, baseUrl, db };
}

describe('Identity & access module integration tests (P1-06)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: DatabaseClient;
  let testDb: TestDbInstance;
  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;
  let previousTrustedOrigins: string | undefined;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    previousTrustedOrigins = process.env['AUTH_TRUSTED_ORIGINS'];

    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
    process.env['AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3000,http://127.0.0.1';

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;

    const created = await createConfiguredTestApp();
    app = created.app;
    baseUrl = created.baseUrl;
    db = created.db;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = previousDatabaseUrl;
    }
    if (previousAuthSecret === undefined) {
      delete process.env['BETTER_AUTH_SECRET'];
    } else {
      process.env['BETTER_AUTH_SECRET'] = previousAuthSecret;
    }
    if (previousTrustedOrigins === undefined) {
      delete process.env['AUTH_TRUSTED_ORIGINS'];
    } else {
      process.env['AUTH_TRUSTED_ORIGINS'] = previousTrustedOrigins;
    }
    if (testDb) {
      await testDb.teardown();
    }
  });

  async function signUp(email: string, password: string, name: string) {
    const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ email, password, name }),
    });
    const body = (await res.json()) as { user?: { id: string; email: string } };
    return { res, body, cookie: extractCookieHeader(res) };
  }

  async function signIn(
    email: string,
    password: string,
    targetBaseUrl = baseUrl,
    forwardedFor?: string,
  ) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
    };
    if (forwardedFor) {
      headers['X-Forwarded-For'] = forwardedFor;
    }
    const res = await fetch(`${targetBaseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    });
    return { res, cookie: extractCookieHeader(res) };
  }

  it('AC1 & AC8: Sign up -> sign in -> session cookie -> protected endpoint returns Principal with role customer; password never stored or logged in plain text', async () => {
    const email = 'alice@example.com';
    const plainPassword = 'SuperSecretPassword!2026#Unique';

    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    const consoleLogSpy = vi.spyOn(console, 'log');
    const consoleErrorSpy = vi.spyOn(console, 'error');

    try {
      const signUpResult = await signUp(email, plainPassword, 'Alice Traveler');
      expect(signUpResult.res.status).toBe(200);
      expect(signUpResult.body.user?.id).toBeTruthy();

      const signInResult = await signIn(email, plainPassword, baseUrl, '10.0.0.1');
      expect(signInResult.res.status).toBe(200);
      expect(signInResult.cookie).toContain('better-auth.session_token=');

      // Verify cookie security attributes (HttpOnly, SameSite=Lax)
      const setCookies = signInResult.res.headers.getSetCookie().join('; ');
      expect(setCookies.toLowerCase()).toContain('httponly');
      expect(setCookies.toLowerCase()).toContain('samesite=lax');

      // Protected endpoint returns our Principal with role 'customer'
      const meRes = await fetch(`${baseUrl}/__test/me`, {
        headers: { Cookie: signInResult.cookie },
      });
      expect(meRes.status).toBe(200);
      const principal = (await meRes.json()) as Principal;
      expect(principal).toEqual({
        userId: signUpResult.body.user?.id,
        kind: 'customer',
        roles: ['customer'],
      });

      // AC8: Password is never stored in plain text in identity.account
      const accounts = await db
        .select()
        .from(identityAccounts)
        .where(eq(identityAccounts.userId, principal.userId));
      expect(accounts.length).toBeGreaterThan(0);
      for (const account of accounts) {
        expect(account.password).toBeTruthy();
        expect(account.password).not.toBe(plainPassword);
        expect(account.password).not.toContain(plainPassword);
      }

      // AC8: Password is never logged in plain text
      const allLogged = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
        ...consoleErrorSpy.mock.calls,
      ]
        .flat()
        .map((arg) => String(arg))
        .join('\n');
      expect(allLogged).not.toContain(plainPassword);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('AC2: Missing, invalid, expired, and signed-out sessions return 401 problem+json', async () => {
    // 1. Missing session cookie -> 401 problem+json
    const noCookieRes = await fetch(`${baseUrl}/__test/me`, {
      headers: { 'Accept-Language': 'en' },
    });
    expect(noCookieRes.status).toBe(401);
    expect(noCookieRes.headers.get('Content-Type')).toContain('application/problem+json');
    const noCookieProblem = (await noCookieRes.json()) as { status: number; title: string };
    expect(noCookieProblem.status).toBe(401);
    expect(noCookieProblem.title).toBe('Unauthorized');

    // 2. Invalid session cookie -> 401 problem+json
    const invalidRes = await fetch(`${baseUrl}/__test/me`, {
      headers: { Cookie: 'better-auth.session_token=invalid-token-value' },
    });
    expect(invalidRes.status).toBe(401);
    expect(invalidRes.headers.get('Content-Type')).toContain('application/problem+json');

    // 3. Sign up + sign in, then expire session in DB -> 401
    const email = 'bob-sessions@example.com';
    const password = 'BobPassword!2026';
    const { body } = await signUp(email, password, 'Bob Sessions');
    const userId = body.user!.id;

    const { cookie: expiredCookie } = await signIn(email, password, baseUrl, '10.0.0.2');
    await db
      .update(identitySessions)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(identitySessions.userId, userId));

    const expiredRes = await fetch(`${baseUrl}/__test/me`, {
      headers: { Cookie: expiredCookie },
    });
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.headers.get('Content-Type')).toContain('application/problem+json');

    // 4. Sign in again, then sign out -> old cookie returns 401
    const { cookie: freshCookie } = await signIn(email, password, baseUrl, '10.0.0.3');
    const okBeforeSignOut = await fetch(`${baseUrl}/__test/me`, {
      headers: { Cookie: freshCookie },
    });
    expect(okBeforeSignOut.status).toBe(200);

    const signOutRes = await fetch(`${baseUrl}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        Cookie: freshCookie,
        Origin: 'http://localhost:3000',
      },
    });
    expect(signOutRes.status).toBe(200);

    const afterSignOutRes = await fetch(`${baseUrl}/__test/me`, {
      headers: { Cookie: freshCookie },
    });
    expect(afterSignOutRes.status).toBe(401);
    expect(afterSignOutRes.headers.get('Content-Type')).toContain('application/problem+json');
  });

  it('AC3: @Roles("admin") denies customer with 403 problem+json and allows after grant-role admin', async () => {
    const email = 'carol-roles@example.com';
    const password = 'CarolPassword!2026';
    await signUp(email, password, 'Carol Roles');
    const { cookie } = await signIn(email, password, baseUrl, '10.0.0.4');

    // Customer cannot access @Roles('admin')
    const deniedRes = await fetch(`${baseUrl}/__test/admin-only`, {
      headers: { Cookie: cookie, 'Accept-Language': 'en' },
    });
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.headers.get('Content-Type')).toContain('application/problem+json');
    const problem = (await deniedRes.json()) as { status: number; title: string };
    expect(problem.status).toBe(403);
    expect(problem.title).toBe('Forbidden');

    // Grant admin role via our identity:grant-role function
    await grantRoleByEmail(db, email, 'admin');

    // Now access succeeds and Principal kind reflects 'staff'
    const allowedRes = await fetch(`${baseUrl}/__test/admin-only`, {
      headers: { Cookie: cookie },
    });
    expect(allowedRes.status).toBe(200);
    const allowedBody = (await allowedRes.json()) as { ok: boolean; userId: string };
    expect(allowedBody.ok).toBe(true);

    const meRes = await fetch(`${baseUrl}/__test/me`, {
      headers: { Cookie: cookie },
    });
    const principal = (await meRes.json()) as Principal;
    expect(principal.kind).toBe('staff');
    expect(principal.roles).toContain('admin');
    expect(principal.roles).toContain('customer');

    // Verify role row in identity.user_roles
    const roleRows = await db
      .select()
      .from(identityUserRoles)
      .where(eq(identityUserRoles.userId, principal.userId));
    expect(roleRows.map((r) => r.role).sort()).toEqual(['admin', 'customer']);
  });

  it('AC4: Cross-account isolation - user A cannot read user B private resource (403) and vice versa', async () => {
    const userA = await signUp('user-a@example.com', 'UserAPassword!2026', 'User A');
    const userB = await signUp('user-b@example.com', 'UserBPassword!2026', 'User B');
    const userAId = userA.body.user!.id;
    const userBId = userB.body.user!.id;

    const { cookie: cookieA } = await signIn(
      'user-a@example.com',
      'UserAPassword!2026',
      baseUrl,
      '10.0.0.5',
    );
    const { cookie: cookieB } = await signIn(
      'user-b@example.com',
      'UserBPassword!2026',
      baseUrl,
      '10.0.0.6',
    );

    // User A reads own resource -> 200
    const aOwn = await fetch(`${baseUrl}/__test/users/${userAId}/private`, {
      headers: { Cookie: cookieA },
    });
    expect(aOwn.status).toBe(200);

    // User A tries to read User B's resource -> 403 problem+json
    const aReadsB = await fetch(`${baseUrl}/__test/users/${userBId}/private`, {
      headers: { Cookie: cookieA },
    });
    expect(aReadsB.status).toBe(403);
    expect(aReadsB.headers.get('Content-Type')).toContain('application/problem+json');

    // User B reads own resource -> 200
    const bOwn = await fetch(`${baseUrl}/__test/users/${userBId}/private`, {
      headers: { Cookie: cookieB },
    });
    expect(bOwn.status).toBe(200);

    // User B tries to read User A's resource -> 403 problem+json
    const bReadsA = await fetch(`${baseUrl}/__test/users/${userAId}/private`, {
      headers: { Cookie: cookieB },
    });
    expect(bReadsA.status).toBe(403);
    expect(bReadsA.headers.get('Content-Type')).toContain('application/problem+json');
  });

  it('AC5: Rate limit returns 429 on repeated wrong passwords and persists state in PostgreSQL across app restarts', async () => {
    const email = 'ratelimit-user@example.com';
    await signUp(email, 'CorrectPassword!2026', 'Rate Limit User');

    const clientIp = '203.0.113.77';
    // Custom rule on /sign-in/email allows max 5 requests per 60s window
    for (let i = 0; i < 5; i++) {
      const { res } = await signIn(email, 'WrongPassword!123', baseUrl, clientIp);
      expect(res.status).toBe(401);
    }

    // 6th attempt within window -> 429 Too Many Requests
    const sixthAttempt = await signIn(email, 'WrongPassword!123', baseUrl, clientIp);
    expect(sixthAttempt.res.status).toBe(429);

    // Verify rate limit state is persisted in identity.rate_limit table
    const rateLimitRows = await db.select().from(identityRateLimits);
    expect(rateLimitRows.length).toBeGreaterThan(0);

    // Restart a fresh NestJS app instance connected to the same DB -> must still return 429!
    const restarted = await createConfiguredTestApp();
    try {
      const afterRestartAttempt = await signIn(
        email,
        'WrongPassword!123',
        restarted.baseUrl,
        clientIp,
      );
      expect(afterRestartAttempt.res.status).toBe(429);
    } finally {
      await restarted.app.close();
    }
  });

  it('AC6: Startup fails fast when BETTER_AUTH_SECRET is missing/short or in production without a real EmailSender', () => {
    const savedSecret = process.env['BETTER_AUTH_SECRET'];
    const savedNodeEnv = process.env['NODE_ENV'];

    try {
      // 1. Missing secret
      delete process.env['BETTER_AUTH_SECRET'];
      expect(() => new IdentityService(db)).toThrow(/BETTER_AUTH_SECRET must be set/);

      // 2. Short secret (< 32 chars)
      process.env['BETTER_AUTH_SECRET'] = 'too-short-secret';
      expect(() => new IdentityService(db)).toThrow(/at least 32 characters/);

      // 3. Production mode without a real EmailSender (undefined or LogOnlyEmailSender)
      process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;
      process.env['NODE_ENV'] = 'production';
      expect(() => new IdentityService(db)).toThrow(/production.*EmailSender/i);

      // 4. Production mode WITH a real EmailSender succeeds
      const realSender: EmailSender = {
        sendVerificationEmail: async () => {},
        sendResetPasswordEmail: async () => {},
      };
      expect(() => new IdentityService(db, realSender)).not.toThrow();
    } finally {
      process.env['BETTER_AUTH_SECRET'] = savedSecret;
      process.env['NODE_ENV'] = savedNodeEnv;
    }
  });

  it('AC9: Idempotency scope is prefixed with userId: for authenticated requests', async () => {
    const user1 = await signUp('idemp-u1@example.com', 'IdempPass1!2026', 'Idemp User 1');
    const user2 = await signUp('idemp-u2@example.com', 'IdempPass2!2026', 'Idemp User 2');
    const user1Id = user1.body.user!.id;
    const user2Id = user2.body.user!.id;

    const { cookie: cookie1 } = await signIn(
      'idemp-u1@example.com',
      'IdempPass1!2026',
      baseUrl,
      '10.0.0.8',
    );
    const { cookie: cookie2 } = await signIn(
      'idemp-u2@example.com',
      'IdempPass2!2026',
      baseUrl,
      '10.0.0.9',
    );

    const sharedKey = 'shared-idempotency-key-ac9';
    const payload = { booking: 'hotel-123' };

    // User 1 sends request with sharedKey
    const res1 = await fetch(`${baseUrl}/__test/idempotent-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
        'Idempotency-Key': sharedKey,
      },
      body: JSON.stringify(payload),
    });
    expect(res1.status).toBe(201);
    expect(res1.headers.get('Idempotent-Replayed')).toBeNull();
    expect(await res1.json()).toEqual({ userId: user1Id, ok: true });

    // User 2 sends request with the SAME sharedKey -> isolated by userId: prefix, NOT replayed
    const res2 = await fetch(`${baseUrl}/__test/idempotent-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
        'Idempotency-Key': sharedKey,
      },
      body: JSON.stringify(payload),
    });
    expect(res2.status).toBe(201);
    expect(res2.headers.get('Idempotent-Replayed')).toBeNull();
    expect(await res2.json()).toEqual({ userId: user2Id, ok: true });

    // Verify stored scopes in platform.idempotency_keys start with `${userId}:`
    const storedRows = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, sharedKey));
    const scopes = storedRows.map((row) => row.scope).sort();
    expect(scopes).toEqual(
      [`${user1Id}:POST /__test/idempotent-auth`, `${user2Id}:POST /__test/idempotent-auth`].sort(),
    );

    // Confirm user1 row exists in identity.user
    const [u1Row] = await db.select().from(identityUsers).where(eq(identityUsers.id, user1Id));
    expect(u1Row?.email).toBe('idemp-u1@example.com');
  });

  it('AC6 (DI): AppModule fails to compile/start when EMAIL_SENDER is LogOnlyEmailSender in production', async () => {
    const savedNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(
        Test.createTestingModule({
          imports: [AppModule],
        }).compile(),
      ).rejects.toThrow(/production.*EmailSender/i);

      // Overriding EMAIL_SENDER with a real sender allows startup in production
      const realSender: EmailSender = {
        sendVerificationEmail: async () => {},
        sendResetPasswordEmail: async () => {},
      };
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(realSender)
        .compile();
      await moduleRef.close();
    } finally {
      process.env['NODE_ENV'] = savedNodeEnv;
    }
  });
});
