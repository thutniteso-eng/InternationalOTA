import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  computeRequestHash,
  computeScope,
  isValidIdempotencyKey,
} from './hash.js';

describe('Idempotency hash & validation utilities', () => {
  describe('isValidIdempotencyKey', () => {
    it('accepts valid 1-255 printable ASCII strings without spaces', () => {
      expect(isValidIdempotencyKey('key-1')).toBe(true);
      expect(isValidIdempotencyKey('a')).toBe(true);
      expect(isValidIdempotencyKey('a'.repeat(255))).toBe(true);
      expect(isValidIdempotencyKey('UUID-v7_123.456:XYZ!#$')).toBe(true);
    });

    it('rejects keys containing spaces or whitespace', () => {
      expect(isValidIdempotencyKey('key with space')).toBe(false);
      expect(isValidIdempotencyKey(' leading-space')).toBe(false);
      expect(isValidIdempotencyKey('trailing-space ')).toBe(false);
      expect(isValidIdempotencyKey('tab\there')).toBe(false);
      expect(isValidIdempotencyKey('newline\nhere')).toBe(false);
    });

    it('rejects empty strings or keys exceeding 255 chars', () => {
      expect(isValidIdempotencyKey('')).toBe(false);
      expect(isValidIdempotencyKey('a'.repeat(256))).toBe(false);
    });

    it('rejects non-string types and non-printable ASCII / unicode', () => {
      expect(isValidIdempotencyKey(null)).toBe(false);
      expect(isValidIdempotencyKey(undefined)).toBe(false);
      expect(isValidIdempotencyKey(12345)).toBe(false);
      expect(isValidIdempotencyKey('unicode-🔑')).toBe(false);
      expect(isValidIdempotencyKey('accent-é')).toBe(false);
    });
  });

  describe('canonicalizeJson', () => {
    it('sorts object keys recursively', () => {
      const obj1 = { z: 1, a: 2, m: { y: 10, x: 20 } };
      const obj2 = { a: 2, m: { x: 20, y: 10 }, z: 1 };
      expect(canonicalizeJson(obj1)).toBe('{"a":2,"m":{"x":20,"y":10},"z":1}');
      expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
    });

    it('preserves array order', () => {
      const arr = [3, 1, 2];
      expect(canonicalizeJson(arr)).toBe('[3,1,2]');
      expect(canonicalizeJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
    });

    it('handles primitives, null, and empty objects', () => {
      expect(canonicalizeJson(null)).toBe('null');
      expect(canonicalizeJson('hello')).toBe('"hello"');
      expect(canonicalizeJson(42)).toBe('42');
      expect(canonicalizeJson(true)).toBe('true');
      expect(canonicalizeJson({})).toBe('{}');
      expect(canonicalizeJson([])).toBe('[]');
    });
  });

  describe('computeScope', () => {
    it('combines METHOD and route pattern', () => {
      const mockReq = {
        method: 'post',
        baseUrl: '/api',
        route: { path: '/bookings' },
      } as unknown as Request;

      expect(computeScope(mockReq)).toBe('POST /api/bookings');
    });

    it('prefixes scope with userId: when a principal is attached', () => {
      const mockReq = {
        method: 'post',
        baseUrl: '/api',
        route: { path: '/bookings' },
        principal: { userId: 'usr_123', kind: 'customer', roles: ['customer'] },
      } as unknown as Request;

      expect(computeScope(mockReq)).toBe('usr_123:POST /api/bookings');
    });
  });

  describe('computeRequestHash', () => {
    it('produces 64-char sha256 hex string identical for equivalent payloads', () => {
      const scope = 'POST /bookings';
      const hash1 = computeRequestHash(scope, { amount: 100, currency: 'USD' });
      const hash2 = computeRequestHash(scope, { currency: 'USD', amount: 100 });

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
    });

    it('produces different hash when scope or payload differs', () => {
      const hash1 = computeRequestHash('POST /bookings', { amount: 100 });
      const hash2 = computeRequestHash('POST /payments', { amount: 100 });
      const hash3 = computeRequestHash('POST /bookings', { amount: 200 });

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });
  });
});
