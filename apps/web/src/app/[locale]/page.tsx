import { t } from '@internationalota/i18n';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CatalogLoadMoreButton } from '@/components/CatalogLoadMoreButton';
import { ProductCard } from '@/components/ProductCard';
import { SiteHeader } from '@/components/SiteHeader';
import { isSupportedWebLocale, type SUPPORTED_WEB_LOCALES } from '@/i18n/config';
import { fetchCatalogList, type PublicCatalogListResponse } from '@/lib/catalog-api';

export const dynamic = 'force-dynamic';

const PAGE_LIMIT = 12;

function buildListHref(
  locale: (typeof SUPPORTED_WEB_LOCALES)[number],
  q: string,
  kind: string,
): string {
  const params = new URLSearchParams();
  if (q) {
    params.set('q', q);
  }
  if (kind === 'tour' || kind === 'activity') {
    params.set('kind', kind);
  }
  const qs = params.toString();
  return qs ? `/${locale}?${qs}` : `/${locale}`;
}

export default async function LocaleHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; kind?: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const kind = sp.kind === 'tour' || sp.kind === 'activity' ? sp.kind : '';

  let listData: PublicCatalogListResponse | null = null;
  let loadFailed = false;
  try {
    listData = await fetchCatalogList({
      locale,
      q,
      kind,
      limit: PAGE_LIMIT,
    });
  } catch {
    loadFailed = true;
  }

  const filterChips = [
    { value: '', label: t(locale, 'demo.list.filter.all') },
    { value: 'tour', label: t(locale, 'demo.list.filter.tour') },
    { value: 'activity', label: t(locale, 'demo.list.filter.activity') },
  ] as const;

  return (
    <>
      <SiteHeader locale={locale} />
      <main className="pageMain">
        <section className="heroIntro">
          <h1 className="pageTitle">{t(locale, 'demo.list.heading')}</h1>
          <p className="pageSubtitle">{t(locale, 'demo.list.subheading')}</p>
        </section>

        <form method="GET" action={`/${locale}`} className="searchBar" role="search">
          {kind ? <input type="hidden" name="kind" value={kind} /> : null}
          <label htmlFor="catalog-search-input" className="searchLabel">
            {t(locale, 'demo.list.searchLabel')}
          </label>
          <input
            id="catalog-search-input"
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t(locale, 'demo.list.searchPlaceholder')}
            className="searchInput"
          />
          <button type="submit" className="primaryButton">
            {t(locale, 'demo.list.searchButton')}
          </button>
          {q || kind ? (
            <Link href={`/${locale}`} className="secondaryButton">
              {t(locale, 'demo.list.clearSearch')}
            </Link>
          ) : null}
        </form>

        <nav className="filterRow" aria-label={t(locale, 'demo.list.filterLabel')}>
          {filterChips.map((chip) => {
            const active = chip.value === kind;
            return (
              <Link
                key={chip.value || 'all'}
                href={buildListHref(locale, q, chip.value)}
                aria-current={active ? 'page' : undefined}
                className={active ? 'chip chipActive' : 'chip'}
              >
                {chip.label}
              </Link>
            );
          })}
        </nav>

        {loadFailed || !listData ? (
          <div className="errorBox" role="alert">
            <h2>{t(locale, 'demo.list.errorTitle')}</h2>
            <p>{t(locale, 'demo.list.errorRetry')}</p>
          </div>
        ) : listData.items.length === 0 ? (
          <div className="stateBox">
            <h2>{t(locale, 'demo.list.emptyTitle')}</h2>
            <p>{t(locale, 'demo.list.emptyHint')}</p>
            {q || kind ? (
              <Link href={`/${locale}`} className="secondaryButton">
                {t(locale, 'demo.list.clearSearch')}
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <p className="resultMeta">
              {t(locale, 'demo.list.resultSummary', { count: listData.items.length })}
            </p>
            <div className="cardGrid">
              {listData.items.map((product) => (
                <ProductCard key={product.id} product={product} locale={locale} />
              ))}
            </div>
            <CatalogLoadMoreButton
              locale={locale}
              initialCursor={listData.nextCursor}
              q={q}
              kind={kind}
              limit={PAGE_LIMIT}
            />
          </>
        )}
      </main>
    </>
  );
}
