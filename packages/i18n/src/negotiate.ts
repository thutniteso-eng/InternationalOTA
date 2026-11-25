export const FALLBACK_DEFAULT_LOCALE = 'vi';

const BCP47_TAG_REGEX = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const QVALUE_REGEX = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

export function getDefaultLocale(): string {
  const fromEnv =
    typeof process !== 'undefined' ? process.env['DEFAULT_LOCALE']?.trim() : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : FALLBACK_DEFAULT_LOCALE;
}

interface ParsedRange {
  tag: string; // lowercase or '*'
  q: number;
  index: number;
}

function parseAcceptLanguageHeader(raw: string): {
  ranges: ParsedRange[];
  excluded: Set<string>;
} {
  const ranges: ParsedRange[] = [];
  const excluded = new Set<string>();

  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]?.trim();
    if (!entry) {
      continue;
    }

    const segments = entry.split(';').map((s) => s.trim());
    const rawTag = segments[0];
    if (!rawTag) {
      continue;
    }

    if (rawTag !== '*' && !BCP47_TAG_REGEX.test(rawTag)) {
      continue;
    }

    let q = 1;
    let valid = true;

    for (let j = 1; j < segments.length; j++) {
      const param = segments[j];
      if (!param) {
        valid = false;
        break;
      }
      const eqIdx = param.indexOf('=');
      if (eqIdx === -1) {
        valid = false;
        break;
      }
      const key = param.slice(0, eqIdx).trim().toLowerCase();
      const val = param.slice(eqIdx + 1).trim();
      if (key !== 'q' || !QVALUE_REGEX.test(val)) {
        valid = false;
        break;
      }
      q = Number.parseFloat(val);
    }

    if (!valid) {
      continue;
    }

    const normalizedTag = rawTag.toLowerCase();
    if (q === 0) {
      excluded.add(normalizedTag);
      continue;
    }

    ranges.push({ tag: normalizedTag, q, index: i });
  }

  // RFC 9110: sort by q descending, stable order for equal q
  ranges.sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index));
  return { ranges, excluded };
}

function matchEnabledTag(
  candidateLower: string,
  enabledByLower: ReadonlyMap<string, string>,
): string | undefined {
  const exact = enabledByLower.get(candidateLower);
  if (exact) {
    return exact;
  }

  // BCP 47 prefix fallback: strip trailing subtags one by one (e.g. zh-hans-cn -> zh-hans -> zh, vi-vn -> vi)
  let prefix = candidateLower;
  while (prefix.includes('-')) {
    prefix = prefix.slice(0, prefix.lastIndexOf('-'));
    const matched = enabledByLower.get(prefix);
    if (matched) {
      return matched;
    }
  }

  return undefined;
}

/**
 * Matches an explicit locale tag (e.g. from `?lang=` query param or URL path)
 * against the enabled locale list using exact or BCP 47 prefix matching.
 */
export function matchLocaleTag(
  tag: string | null | undefined,
  enabled: readonly string[],
): string | undefined {
  if (!tag || typeof tag !== 'string') {
    return undefined;
  }
  const trimmed = tag.trim();
  if (!BCP47_TAG_REGEX.test(trimmed)) {
    return undefined;
  }
  const enabledByLower = new Map<string, string>();
  for (const loc of enabled) {
    enabledByLower.set(loc.toLowerCase(), loc);
  }
  return matchEnabledTag(trimmed.toLowerCase(), enabledByLower);
}

/**
 * RFC 9110 `Accept-Language` negotiation with q-values and BCP 47 prefix matching.
 *
 * - Validates against `enabled` languages only (disabled languages are never selected).
 * - Entries with `q=0` are explicitly excluded.
 * - Malformed or missing headers return `fallback` (defaults to `DEFAULT_LOCALE` env or `'vi'`).
 */
export function negotiateLocale(
  acceptLanguageHeader: string | string[] | null | undefined,
  enabled: readonly string[],
  fallback: string = getDefaultLocale(),
): string {
  if (enabled.length === 0) {
    return fallback;
  }

  const headerValue = Array.isArray(acceptLanguageHeader)
    ? acceptLanguageHeader.join(', ')
    : acceptLanguageHeader;

  if (!headerValue || typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return fallback;
  }

  const enabledByLower = new Map<string, string>();
  for (const loc of enabled) {
    enabledByLower.set(loc.toLowerCase(), loc);
  }

  const { ranges, excluded } = parseAcceptLanguageHeader(headerValue);

  for (const range of ranges) {
    if (range.tag === '*') {
      const fallbackCanonical = enabledByLower.get(fallback.toLowerCase());
      if (fallbackCanonical && !excluded.has(fallbackCanonical.toLowerCase())) {
        return fallbackCanonical;
      }
      for (const loc of enabled) {
        if (!excluded.has(loc.toLowerCase())) {
          return loc;
        }
      }
      continue;
    }

    const matched = matchEnabledTag(range.tag, enabledByLower);
    if (matched && !excluded.has(matched.toLowerCase())) {
      return matched;
    }
  }

  return fallback;
}
