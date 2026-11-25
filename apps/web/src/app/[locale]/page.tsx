import { formatLocalDate, formatMoney, t } from '@internationalota/i18n';
import { createMoney } from '@internationalota/money';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isSupportedWebLocale, SUPPORTED_WEB_LOCALES } from '@/i18n/config';

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  const samplePrice = formatMoney(createMoney(1_500_000n, 'VND'), locale);
  const sampleDate = formatLocalDate('2026-07-15', locale);

  return (
    <main>
      <header>
        <nav aria-label={t(locale, 'common.languageSwitcherLabel')}>
          {SUPPORTED_WEB_LOCALES.map((targetLocale) => (
            <Link
              key={targetLocale}
              href={`/${targetLocale}`}
              hrefLang={targetLocale}
              aria-current={targetLocale === locale ? 'page' : undefined}
              style={{ marginRight: '1rem' }}
            >
              {t(locale, `common.languageName.${targetLocale}`)}
            </Link>
          ))}
        </nav>
      </header>

      <h1>{t(locale, 'common.appName')}</h1>
      <p>{t(locale, 'common.tagline')}</p>
      <p>{t(locale, 'home.subtitle')}</p>
      <p>{t(locale, 'home.destinationCount', { count: 12 })}</p>
      <dl>
        <dt>{t(locale, 'home.samplePriceLabel')}</dt>
        <dd>{samplePrice}</dd>
        <dt>{t(locale, 'home.sampleDateLabel')}</dt>
        <dd>{sampleDate}</dd>
      </dl>
    </main>
  );
}
