import { t, type BuiltinLocale } from '@internationalota/i18n';

export function DemoBanner({ locale }: { readonly locale: BuiltinLocale }): React.JSX.Element {
  return (
    <aside className="demoBanner" aria-label={t(locale, 'demo.banner')}>
      <span>{t(locale, 'demo.banner')}</span>
    </aside>
  );
}
