import { SUPPORTED_WEB_LOCALES } from '@/i18n/config';
import { t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { HeaderAuthControls } from '@/components/HeaderAuthControls';

export function SiteHeader({
  locale,
  alternateHrefs,
}: {
  readonly locale: BuiltinLocale;
  readonly alternateHrefs?: Partial<Record<BuiltinLocale, string>>;
}): React.JSX.Element {
  return (
    <header className="siteHeader">
      <div className="siteHeaderInner">
        <Link href={`/${locale}`} className="brandLink">
          {t(locale, 'demo.nav.home')}
        </Link>

        <div className="siteHeaderRight">
          <HeaderAuthControls locale={locale} />
          <nav className="langNav" aria-label={t(locale, 'common.languageSwitcherLabel')}>
            {SUPPORTED_WEB_LOCALES.map((targetLocale) => {
              const href = alternateHrefs?.[targetLocale] ?? `/${targetLocale}`;
              const isCurrent = targetLocale === locale;
              return (
                <Link
                  key={targetLocale}
                  href={href}
                  hrefLang={targetLocale}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={isCurrent ? 'langLink langLinkActive' : 'langLink'}
                >
                  {t(locale, `common.languageName.${targetLocale}`)}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
}
