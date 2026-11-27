import { t } from '@internationalota/i18n';
import Link from 'next/link';
import { getWebDefaultLocale } from '@/i18n/config';

export default function LocaleNotFoundPage(): React.JSX.Element {
  const locale = getWebDefaultLocale();

  return (
    <main className="pageMain">
      <div className="stateBox">
        <h1 className="pageTitle">{t(locale, 'demo.detail.notFoundTitle')}</h1>
        <p className="pageSubtitle">{t(locale, 'demo.detail.notFoundBody')}</p>
        <div className="loadMoreWrap">
          <Link href={`/${locale}`} className="primaryButton">
            {t(locale, 'demo.nav.backToList')}
          </Link>
        </div>
      </div>
    </main>
  );
}
