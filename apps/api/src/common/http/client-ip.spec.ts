import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  isTrustedProxyIp,
  normalizeIp,
  parseTrustedProxyConfig,
  resolveClientIp,
} from './client-ip.js';

function fakeReq(remoteAddress: string | undefined, headers: IncomingHttpHeaders) {
  return {
    headers,
    socket: { remoteAddress } as Socket,
  };
}

describe('Client IP & trusted proxy resolution (L1)', () => {
  it('normalizes IPv4-mapped IPv6 addresses and rejects invalid IP strings', () => {
    expect(normalizeIp('::ffff:172.29.10.10')).toBe('172.29.10.10');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBeUndefined();
    expect(normalizeIp('')).toBeUndefined();
  });

  it('rejects malformed TRUSTED_PROXY_CIDRS entries fast on startup', () => {
    expect(() => parseTrustedProxyConfig('invalid-cidr/99')).toThrow(/Invalid TRUSTED_PROXY_CIDRS/);
    expect(() => parseTrustedProxyConfig('999.999.999.999')).toThrow(/Invalid TRUSTED_PROXY_CIDRS/);
  });

  it('ignores CF-Connecting-IP and X-Forwarded-For when socket peer is untrusted', () => {
    const cfg = parseTrustedProxyConfig('172.29.10.10/32', 'top-secret');
    const req = fakeReq('198.51.100.42', {
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '203.0.113.9',
      'x-proxy-secret': 'top-secret',
    });
    expect(resolveClientIp(req, cfg)).toBe('198.51.100.42');
  });

  it('ignores CF-Connecting-IP and X-Forwarded-For when X-Proxy-Secret is forged or missing', () => {
    const cfg = parseTrustedProxyConfig('172.29.10.10/32', 'top-secret');
    const req = fakeReq('::ffff:172.29.10.10', {
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '203.0.113.9',
      'x-proxy-secret': 'wrong-secret',
    });
    expect(resolveClientIp(req, cfg)).toBe('172.29.10.10');
  });

  it('extracts CF-Connecting-IP only through verified trusted proxy hop', () => {
    const cfg = parseTrustedProxyConfig('172.29.10.10/32', 'top-secret');
    expect(isTrustedProxyIp('172.29.10.10', cfg)).toBe(true);
    expect(isTrustedProxyIp('172.29.10.11', cfg)).toBe(false);

    const req = fakeReq('::ffff:172.29.10.10', {
      'cf-connecting-ip': '203.0.113.99',
      'x-forwarded-for': '198.51.100.1, 203.0.113.99, 172.29.10.10',
      'x-proxy-secret': 'top-secret',
    });
    expect(resolveClientIp(req, cfg)).toBe('203.0.113.99');
  });
});
