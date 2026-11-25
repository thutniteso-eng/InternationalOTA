import { createHash } from 'node:crypto';
import type { Request } from 'express';

/**
 * Validates that an idempotency key is between 1 and 255 printable ASCII characters without spaces.
 * Printable ASCII range: 0x21 ('!') to 0x7E ('~').
 */
export function isValidIdempotencyKey(key: unknown): key is string {
  if (typeof key !== 'string') {
    return false;
  }
  return /^[\x21-\x7E]{1,255}$/.test(key);
}

/**
 * Serializes a value into canonical JSON:
 * - Object keys are sorted recursively in lexicographical order.
 * - Arrays preserve their exact element order.
 * - Non-object primitives are serialized with standard JSON.stringify.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? '';
  }

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`);
  return '{' + entries.join(',') + '}';
}

/**
 * Computes the scope identifier for an incoming HTTP request:
 * - Authenticated requests (principal present): `<userId>:<METHOD> <routePattern>`
 * - Anonymous requests: `<METHOD> <routePattern>` (e.g. 'POST /bookings').
 */
export function computeScope(req: Request): string {
  const method = req.method.toUpperCase();
  const route = req.route as { path?: string } | undefined;
  const routePattern = (req.baseUrl || '') + (route?.path || req.path);
  const baseScope = `${method} ${routePattern}`;

  const principal = (req as Request & { principal?: { userId?: string } }).principal;
  if (principal?.userId) {
    return `${principal.userId}:${baseScope}`;
  }

  return baseScope;
}

/**
 * Computes the SHA-256 request hash from the scope and canonical JSON request body:
 * SHA-256 hex of (scope + '\n' + canonical JSON body).
 */
export function computeRequestHash(scope: string, body: unknown): string {
  const canonicalBody = canonicalizeJson(body);
  const payload = `${scope}\n${canonicalBody}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
