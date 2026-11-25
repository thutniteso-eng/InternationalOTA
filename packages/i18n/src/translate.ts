import { IntlMessageFormat } from 'intl-messageformat';
import { getCatalog } from './catalogs.ts';
import { getDefaultLocale } from './negotiate.ts';

export class MissingTranslationKeyError extends Error {
  constructor(
    readonly locale: string,
    readonly key: string,
  ) {
    super(`Unknown translation key "${key}" for locale "${locale}"`);
    this.name = 'MissingTranslationKeyError';
  }
}

export type I18nWarnLogger = (message: string, meta: { locale: string; key: string }) => void;

let registeredWarnLogger: I18nWarnLogger | undefined;

export function setI18nWarnLogger(logger: I18nWarnLogger | undefined): void {
  registeredWarnLogger = logger;
}

const compiledCache = new Map<string, IntlMessageFormat>();

function getCompiledMessage(locale: string, key: string, template: string): IntlMessageFormat {
  const cacheKey = `${locale}\u0000${key}`;
  let compiled = compiledCache.get(cacheKey);
  if (!compiled) {
    compiled = new IntlMessageFormat(template, locale);
    compiledCache.set(cacheKey, compiled);
  }
  return compiled;
}

function isNonFatalMissingKeyEnv(): boolean {
  if (typeof process === 'undefined') {
    return false;
  }
  const appEnv = process.env['APP_ENV']?.trim().toLowerCase();
  if (appEnv === 'staging' || appEnv === 'production') {
    return true;
  }
  return process.env['NODE_ENV'] === 'production';
}

function emitMissingKeyWarning(locale: string, key: string): void {
  const message = `Unknown translation key "${key}" for locale "${locale}"`;
  if (registeredWarnLogger) {
    registeredWarnLogger(message, { locale, key });
    return;
  }
  if (typeof process !== 'undefined' && process.stderr?.write) {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', event: 'i18n_missing_key', locale, key, msg: message })}\n`,
    );
  }
}

/**
 * Formats a localized ICU MessageFormat message by key.
 *
 * - Unknown key: throws `MissingTranslationKeyError` in development/test,
 *   logs a WARN and returns `key` in production (`NODE_ENV === 'production'`).
 */
export function t(
  locale: string,
  key: string,
  values?: Record<string, string | number | boolean | Date | null | undefined>,
): string {
  const catalog = getCatalog(locale) ?? getCatalog(getDefaultLocale());
  const template = catalog?.[key];

  if (template === undefined) {
    if (isNonFatalMissingKeyEnv()) {
      emitMissingKeyWarning(locale, key);
      return key;
    }
    throw new MissingTranslationKeyError(locale, key);
  }

  const formatter = getCompiledMessage(locale, key, template);
  const formatted = formatter.format(values);
  return Array.isArray(formatted) ? formatted.map(String).join('') : String(formatted);
}
