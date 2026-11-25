import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from '@internationalota/db';

export const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{8,64}$/;

export interface RequestContextStore {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Accepts an incoming `X-Request-Id` header value only if it matches
 * `^[A-Za-z0-9._-]{8,64}$`; otherwise generates a fresh UUIDv7.
 */
export function resolveRequestId(headerValue: string | string[] | undefined): string {
  if (typeof headerValue === 'string' && REQUEST_ID_REGEX.test(headerValue)) {
    return headerValue;
  }
  return uuidv7();
}

export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestContextStorage.run({ requestId }, fn);
}
