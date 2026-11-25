import { IntlMessageFormat } from 'intl-messageformat';
import type { MessageCatalog } from './catalogs.ts';

export interface CatalogParityResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

interface AstNodeLike {
  type?: number;
  value?: string;
  options?: Record<string, { value?: AstNodeLike[] }>;
  children?: AstNodeLike[];
}

/**
 * Recursively extracts all ICU placeholder argument names from a compiled
 * `IntlMessageFormat` AST.
 *
 * AST node types from `@formatjs/icu-messageformat-parser`:
 * - 0: literal
 * - 1: argument (`{name}`)
 * - 2: number (`{n, number}`)
 * - 3: date (`{d, date}`)
 * - 4: time (`{t, time}`)
 * - 5: select (`{g, select, ...}`)
 * - 6: plural (`{c, plural, ...}`)
 * - 7: pound (`#`)
 * - 8: tag (`<b>...</b>`)
 */
export function extractIcuArguments(template: string, locale: string): string[] {
  const mf = new IntlMessageFormat(template, locale);
  const ast = mf.getAst() as unknown as AstNodeLike[];
  const args = new Set<string>();

  const walk = (nodes: readonly AstNodeLike[] | undefined): void => {
    if (!nodes) {
      return;
    }
    for (const node of nodes) {
      if (
        typeof node.type === 'number' &&
        node.type >= 1 &&
        node.type <= 6 &&
        typeof node.value === 'string'
      ) {
        args.add(node.value);
      }
      if (node.options) {
        for (const opt of Object.values(node.options)) {
          walk(opt.value);
        }
      }
      if (node.children) {
        walk(node.children);
      }
    }
  };

  walk(ast);
  return [...args].sort();
}

/**
 * Validates that every locale catalog contains the exact same set of keys and
 * that every key declares the exact same ICU MessageFormat argument names across
 * all locales.
 */
export function validateCatalogParity(
  catalogs: Readonly<Record<string, MessageCatalog>>,
): CatalogParityResult {
  const locales = Object.keys(catalogs).sort();
  const errors: string[] = [];

  if (locales.length < 2) {
    return { ok: true, errors };
  }

  const allKeys = new Set<string>();
  for (const locale of locales) {
    const catalog = catalogs[locale]!;
    for (const key of Object.keys(catalog)) {
      allKeys.add(key);
    }
  }

  const sortedKeys = [...allKeys].sort();

  for (const key of sortedKeys) {
    const presentIn: string[] = [];
    const missingIn: string[] = [];

    for (const locale of locales) {
      if (Object.prototype.hasOwnProperty.call(catalogs[locale], key)) {
        presentIn.push(locale);
      } else {
        missingIn.push(locale);
      }
    }

    if (missingIn.length > 0) {
      for (const locale of missingIn) {
        errors.push(
          `Missing key "${key}" in locale "${locale}" (present in: ${presentIn.join(', ')})`,
        );
      }
      continue;
    }

    // All locales have this key -> verify ICU argument parity
    const argsByLocale = new Map<string, string[]>();
    let parseFailed = false;

    for (const locale of locales) {
      const template = catalogs[locale]![key]!;
      try {
        argsByLocale.set(locale, extractIcuArguments(template, locale));
      } catch (err) {
        parseFailed = true;
        errors.push(
          `Invalid ICU syntax for key "${key}" in locale "${locale}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (parseFailed) {
      continue;
    }

    const referenceLocale = locales[0]!;
    const referenceArgs = argsByLocale.get(referenceLocale) ?? [];
    const referenceSig = JSON.stringify(referenceArgs);

    for (let i = 1; i < locales.length; i++) {
      const locale = locales[i]!;
      const localeArgs = argsByLocale.get(locale) ?? [];
      if (JSON.stringify(localeArgs) !== referenceSig) {
        errors.push(
          `ICU argument mismatch for key "${key}": ${referenceLocale}=[${referenceArgs.join(', ')}] vs ${locale}=[${localeArgs.join(', ')}]`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
