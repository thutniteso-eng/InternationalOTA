import { eq, languages, type DatabaseClient } from '@internationalota/db';
import {
  BUILTIN_LOCALES,
  getDefaultLocale,
  matchLocaleTag,
  negotiateLocale,
} from '@internationalota/i18n';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';

/**
 * Resolves request locales against the enabled languages stored in `reference.languages`.
 *
 * Enabled languages are loaded and cached on application startup (`onModuleInit`),
 * with a fallback to `BUILTIN_LOCALES` (`['vi', 'en']`) if the table has not yet been seeded.
 */
@Injectable()
export class LocaleService implements OnModuleInit {
  private enabledLocales: readonly string[] = BUILTIN_LOCALES;

  constructor(@Inject(DRIZZLE_DB) private readonly db: DatabaseClient) {}

  async onModuleInit(): Promise<void> {
    await this.refreshEnabledLocales();
  }

  async refreshEnabledLocales(): Promise<readonly string[]> {
    try {
      const rows = await this.db
        .select({ tag: languages.tag })
        .from(languages)
        .where(eq(languages.enabled, true));

      if (rows.length > 0) {
        this.enabledLocales = rows.map((r) => r.tag);
      }
    } catch {
      // Keep safe default (BUILTIN_LOCALES) if reference.languages is unavailable in minimal test harnesses
    }
    return this.enabledLocales;
  }

  getEnabledLocales(): readonly string[] {
    return this.enabledLocales;
  }

  /**
   * Resolution precedence:
   * 1. Explicit `?lang=` query parameter (validated against enabled languages)
   * 2. `Accept-Language` HTTP header (RFC 9110 q-values + BCP 47 prefix matching)
   * 3. Default locale (`DEFAULT_LOCALE` env, defaulting to `'vi'`)
   */
  resolveLocale(queryLang: unknown, acceptLanguageHeader: string | string[] | undefined): string {
    const enabled = this.enabledLocales;
    const configuredDefault = getDefaultLocale();
    const fallback = matchLocaleTag(configuredDefault, enabled) ?? enabled[0] ?? configuredDefault;

    const rawQuery: unknown = Array.isArray(queryLang) ? queryLang[0] : queryLang;
    if (typeof rawQuery === 'string' && rawQuery.trim().length > 0) {
      const explicitMatch = matchLocaleTag(rawQuery, enabled);
      if (explicitMatch) {
        return explicitMatch;
      }
    }

    return negotiateLocale(acceptLanguageHeader, enabled, fallback);
  }
}
