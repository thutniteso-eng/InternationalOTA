import type { BuiltinLocale } from '@internationalota/i18n';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly role?: string;
}

export interface AuthSession {
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly expiresAt: string;
  };
  readonly user: AuthUser;
}

export type AuthActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rateLimited?: boolean; readonly message?: string };

/**
 * Restricts `returnTo` redirects to safe relative same-origin paths.
 * Rejects protocol-relative URLs (`//`), full URLs (`https://`), backslashes, and control characters.
 */
export function sanitizeReturnTo(
  raw: string | null | undefined,
  fallbackLocale: BuiltinLocale,
): string {
  const fallback = `/${fallbackLocale}`;
  if (!raw) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) {
    return fallback;
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return fallback;
  }
  if (/[\u0000-\u001F\u007F\\]/.test(trimmed)) {
    return fallback;
  }
  try {
    const parsed = new URL(trimmed, 'http://local.invalid');
    if (parsed.origin !== 'http://local.invalid') {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export async function fetchBrowserSession(
  fetchFn: typeof fetch = fetch,
): Promise<AuthSession | null> {
  try {
    const res = await fetchFn('/api/auth/get-session', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as Partial<AuthSession> | null;
    if (!body || !body.user || !body.session) {
      return null;
    }
    return body as AuthSession;
  } catch {
    return null;
  }
}

async function parseAuthError(res: Response): Promise<AuthActionResult> {
  if (res.status === 429) {
    return { ok: false, rateLimited: true };
  }
  const body = (await res.json().catch(() => null)) as {
    message?: string;
    detail?: string;
  } | null;
  const msg = body?.message || body?.detail;
  return msg ? { ok: false, message: msg } : { ok: false };
}

export async function signInWithEmail(
  input: { readonly email: string; readonly password: string },
  fetchFn: typeof fetch = fetch,
): Promise<AuthActionResult> {
  const res = await fetchFn('/api/auth/sign-in/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return parseAuthError(res);
  }
  return { ok: true };
}

export async function signUpWithEmail(
  input: {
    readonly name: string;
    readonly email: string;
    readonly password: string;
    readonly callbackURL?: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<AuthActionResult> {
  const res = await fetchFn('/api/auth/sign-up/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return parseAuthError(res);
  }
  return { ok: true };
}

export async function signOutUser(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resendVerificationEmail(
  email: string,
  callbackURL?: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthActionResult> {
  const res = await fetchFn('/api/auth/send-verification-email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(callbackURL ? { email, callbackURL } : { email }),
  });
  if (!res.ok) {
    return parseAuthError(res);
  }
  return { ok: true };
}
