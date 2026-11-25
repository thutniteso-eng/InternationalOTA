import enMessages from '../messages/en.json' with { type: 'json' };
import viMessages from '../messages/vi.json' with { type: 'json' };

export type MessageCatalog = Readonly<Record<string, string>>;

export const BUILTIN_LOCALES = ['vi', 'en'] as const;
export type BuiltinLocale = (typeof BUILTIN_LOCALES)[number];

export const MESSAGE_CATALOGS: Readonly<Record<string, MessageCatalog>> = Object.freeze({
  vi: Object.freeze(viMessages),
  en: Object.freeze(enMessages),
});

export function getCatalog(locale: string): MessageCatalog | undefined {
  const exact = MESSAGE_CATALOGS[locale];
  if (exact) {
    return exact;
  }
  const lower = locale.toLowerCase();
  for (const [tag, catalog] of Object.entries(MESSAGE_CATALOGS)) {
    if (tag.toLowerCase() === lower) {
      return catalog;
    }
  }
  return undefined;
}
