import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

export interface TrustedProxyConfig {
  readonly blockList: BlockList;
  readonly hasEntries: boolean;
  readonly proxySharedSecret?: string;
}

/**
 * Normalizes a socket or header IP string (e.g. strips `::ffff:` IPv4-mapped IPv6 prefix).
 * Returns `undefined` when the value is not a valid IPv4 or IPv6 address.
 */
export function normalizeIp(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mappedV4 = lower.slice('::ffff:'.length);
    if (isIP(mappedV4) === 4) {
      return mappedV4;
    }
  }

  return isIP(trimmed) !== 0 ? lower : undefined;
}

/**
 * Parses `TRUSTED_PROXY_CIDRS` (comma-separated IPs or CIDRs, e.g. `172.29.10.10/32`)
 * into a Node `BlockList`. Throws if any entry is malformed so proxy misconfiguration
 * fails fast on startup.
 */
export function parseTrustedProxyConfig(
  rawCidrs = process.env['TRUSTED_PROXY_CIDRS'],
  proxySharedSecret = process.env['PROXY_SHARED_SECRET']?.trim(),
): TrustedProxyConfig {
  const blockList = new BlockList();
  let hasEntries = false;

  if (rawCidrs && rawCidrs.trim().length > 0) {
    const entries = rawCidrs
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    for (const entry of entries) {
      const slashIdx = entry.lastIndexOf('/');
      if (slashIdx === -1) {
        const ip = normalizeIp(entry);
        const version = ip ? isIP(ip) : 0;
        if (!ip || version === 0) {
          throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: "${entry}"`);
        }
        blockList.addAddress(ip, version === 4 ? 'ipv4' : 'ipv6');
        hasEntries = true;
      } else {
        const networkRaw = entry.slice(0, slashIdx);
        const prefixRaw = entry.slice(slashIdx + 1);
        const networkIp = normalizeIp(networkRaw);
        const version = networkIp ? isIP(networkIp) : 0;
        const maxBits = version === 4 ? 32 : 128;
        const prefix = /^\d+$/.test(prefixRaw) ? Number.parseInt(prefixRaw, 10) : NaN;
        if (
          !networkIp ||
          version === 0 ||
          !Number.isInteger(prefix) ||
          prefix < 0 ||
          prefix > maxBits
        ) {
          throw new Error(`Invalid TRUSTED_PROXY_CIDRS CIDR entry: "${entry}"`);
        }
        blockList.addSubnet(networkIp, prefix, version === 4 ? 'ipv4' : 'ipv6');
        hasEntries = true;
      }
    }
  }

  return {
    blockList,
    hasEntries,
    ...(proxySharedSecret ? { proxySharedSecret } : {}),
  };
}

export function isTrustedProxyIp(ip: string | undefined, config: TrustedProxyConfig): boolean {
  if (!config.hasEntries || !ip) {
    return false;
  }
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return false;
  }
  const version = isIP(normalized);
  if (version === 0) {
    return false;
  }
  return config.blockList.check(normalized, version === 4 ? 'ipv4' : 'ipv6');
}

function hasValidProxySecret(headers: IncomingHttpHeaders, expectedSecret?: string): boolean {
  if (!expectedSecret) {
    return true;
  }
  const raw = headers['x-proxy-secret'];
  if (typeof raw !== 'string' || raw.length === 0) {
    return false;
  }
  const a = Buffer.from(raw, 'utf8');
  const b = Buffer.from(expectedSecret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function getHeaderString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const val = headers[name];
  if (typeof val === 'string') {
    return val;
  }
  if (Array.isArray(val) && val.length > 0) {
    return val[0];
  }
  return undefined;
}

/**
 * Resolves the real client IP for rate limiting and audit logging (L1):
 * - Trusts `CF-Connecting-IP` (or rightmost non-trusted hop of `X-Forwarded-For`) ONLY when:
 *   1. the immediate TCP socket peer IP (`req.socket.remoteAddress`) matches `TRUSTED_PROXY_CIDRS`, AND
 *   2. if `PROXY_SHARED_SECRET` is configured, `X-Proxy-Secret` matches it in constant time.
 * - Otherwise, client-supplied `CF-Connecting-IP` / `X-Forwarded-For` headers are completely ignored
 *   and the actual TCP socket peer IP is returned.
 */
export function resolveClientIp(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  config: TrustedProxyConfig,
): string | undefined {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  const trustedHop =
    socketIp !== undefined &&
    isTrustedProxyIp(socketIp, config) &&
    hasValidProxySecret(req.headers, config.proxySharedSecret);

  if (!trustedHop) {
    return socketIp;
  }

  const cfConnectingIp = normalizeIp(getHeaderString(req.headers, 'cf-connecting-ip'));
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const xff = getHeaderString(req.headers, 'x-forwarded-for');
  if (xff) {
    const candidates = xff
      .split(',')
      .map((part) => normalizeIp(part))
      .filter((ip): ip is string => ip !== undefined);

    // Walk from right to left and return the first hop that is not one of our trusted proxies
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i]!;
      if (!isTrustedProxyIp(candidate, config)) {
        return candidate;
      }
    }
  }

  return socketIp;
}
