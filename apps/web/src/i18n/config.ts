import {
  BUILTIN_LOCALES,
  getDefaultLocale,
  negotiateLocale,
  type BuiltinLocale,
} from '@internationalota/i18n';
import type { Metadata } from 'next';

export const SUPPORTED_WEB_LOCALES: readonly BuiltinLocale[] = BUILTIN_LOCALES;

export function getWebDefaultLocale(): BuiltinLocale {
  const configured = getDefaultLocale();
  return isSupportedWebLocale(configured) ? configured : 'vi';
}

export function isSupportedWebLocale(value: string): value is BuiltinLocale {
  return (SUPPORTED_WEB_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolves the web locale from an `Accept-Language` header using the exact same
 * RFC 9110 negotiation logic as the API (`@internationalota/i18n`).
 */
export function resolveWebLocale(acceptLanguageHeader: string | null | undefined): BuiltinLocale {
  const fallback = getWebDefaultLocale();
  const negotiated = negotiateLocale(acceptLanguageHeader, SUPPORTED_WEB_LOCALES, fallback);
  return isSupportedWebLocale(negotiated) ? negotiated : fallback;
}

/**
 * Builds Next.js `metadata.alternates` with canonical URL, per-locale `hreflang`
 * alternates, and `x-default` for SEO.
 */
export function buildHreflangAlternates(
  locale: BuiltinLocale,
  pathname = '',
): NonNullable<Metadata['alternates']> {
  const suffix = pathname && !pathname.startsWith('/') ? `/${pathname}` : pathname;
  const languages: Record<string, string> = {};
  for (const loc of SUPPORTED_WEB_LOCALES) {
    languages[loc] = `/${loc}${suffix}`;
  }
  languages['x-default'] = `/${getWebDefaultLocale()}${suffix}`;

  return {
    canonical: `/${locale}${suffix}`,
    languages,
  };
}
