import { t, type BuiltinLocale } from '@internationalota/i18n';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteHeader } from '@/components/SiteHeader';
import { TourAvailabilityQuote } from '@/components/TourAvailabilityQuote';
import { getWebDefaultLocale, isSupportedWebLocale, SUPPORTED_WEB_LOCALES } from '@/i18n/config';
import {
  computeAvailabilityWindow,
  fetchAvailability,
  fetchCatalogDetail,
  formatCancellationSentences,
  formatDuration,
  type ProductKind,
  type PublicAvailabilityItem,
} from '@/lib/catalog-api';

export const dynamic = 'force-dynamic';

function coverClassForKind(kind: ProductKind): string {
  if (kind === 'activity') {
    return 'detailHeroCover kindCoverActivity';
  }
  if (kind === 'transfer') {
    return 'detailHeroCover kindCoverTransfer';
  }
  return 'detailHeroCover kindCoverTour';
}

function buildDetailAlternates(
  locale: BuiltinLocale,
  slug: string,
  alternateSlugs: Readonly<Record<string, string>>,
): NonNullable<Metadata['alternates']> {
  const languages: Record<string, string> = {};
  for (const targetLoc of SUPPORTED_WEB_LOCALES) {
    const targetSlug = alternateSlugs[targetLoc];
    if (targetSlug) {
      languages[targetLoc] = `/${targetLoc}/tours/${targetSlug}`;
    }
  }
  const defaultLoc = getWebDefaultLocale();
  const defaultSlug = alternateSlugs[defaultLoc];
  if (defaultSlug) {
    languages['x-default'] = `/${defaultLoc}/tours/${defaultSlug}`;
  }

  return {
    canonical: `/${locale}/tours/${slug}`,
    languages,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isSupportedWebLocale(locale)) {
    return {};
  }

  const product = await fetchCatalogDetail(locale, slug).catch(() => null);
  if (!product) {
    return {
      title: t(locale, 'demo.detail.notFoundTitle'),
    };
  }

  return {
    title: `${product.title} — ${t(locale, 'demo.detail.titleSuffix')}`,
    description: product.summary,
    alternates: buildDetailAlternates(locale, slug, product.alternateSlugs),
  };
}

export default async function TourDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<React.JSX.Element> {
  const { locale, slug } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  const product = await fetchCatalogDetail(locale, slug);
  if (!product) {
    notFound();
  }

  const windowInfo = computeAvailabilityWindow(product.timeZone, 0);
  let initialDepartures: readonly PublicAvailabilityItem[] = [];
  try {
    const avail = await fetchAvailability(product.id, windowInfo.fromDate, windowInfo.toDate);
    initialDepartures = avail.items;
  } catch {
    initialDepartures = [];
  }

  const alternateHrefs: Partial<Record<BuiltinLocale, string>> = {};
  for (const targetLoc of SUPPORTED_WEB_LOCALES) {
    const targetSlug = product.alternateSlugs[targetLoc];
    alternateHrefs[targetLoc] = targetSlug ? `/${targetLoc}/tours/${targetSlug}` : `/${targetLoc}`;
  }

  const kindLabel = t(locale, `demo.list.kind.${product.kind}`);
  const durationLabel = formatDuration(product.durationMinutes, locale);
  const policyLines = formatCancellationSentences(product.cancellationSummary, locale);
  const osmUrl = product.location
    ? `https://www.openstreetmap.org/?mlat=${product.location.lat}&mlon=${product.location.lng}#map=14/${product.location.lat}/${product.location.lng}`
    : null;

  return (
    <>
      <SiteHeader locale={locale} alternateHrefs={alternateHrefs} />
      <main className="pageMain">
        <div className="backNav">
          <Link href={`/${locale}`} className="backLink">
            {t(locale, 'demo.nav.backToList')}
          </Link>
        </div>

        <div className="detailLayout">
          <article className="detailCard">
            <div className={coverClassForKind(product.kind)} aria-hidden="true">
              <span className="kindBadge">{kindLabel}</span>
            </div>

            <div className="detailContent">
              <h1 className="pageTitle">{product.title}</h1>
              <p className="pageSubtitle">{product.summary}</p>

              <dl className="factsList">
                {durationLabel ? (
                  <div>
                    <dt>{t(locale, 'demo.detail.durationLabel')}</dt>
                    <dd>{durationLabel}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t(locale, 'demo.detail.regionLabel')}</dt>
                  <dd>{product.region}</dd>
                </div>
                {product.meetingPointNote ? (
                  <div>
                    <dt>{t(locale, 'demo.detail.meetingPointLabel')}</dt>
                    <dd>{product.meetingPointNote}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t(locale, 'demo.detail.supplierLabel')}</dt>
                  <dd>{product.supplierName}</dd>
                </div>
              </dl>

              {osmUrl ? (
                <a href={osmUrl} target="_blank" rel="noopener noreferrer" className="mapLink">
                  {t(locale, 'demo.detail.openMap')}
                </a>
              ) : null}

              <section className="detailSection" aria-labelledby="overview-heading">
                <h2 id="overview-heading" className="sectionHeading">
                  {t(locale, 'demo.detail.descriptionHeading')}
                </h2>
                <p>{product.description}</p>
              </section>

              {product.highlights.length > 0 ? (
                <section className="detailSection" aria-labelledby="highlights-heading">
                  <h2 id="highlights-heading" className="sectionHeading">
                    {t(locale, 'demo.detail.highlightsHeading')}
                  </h2>
                  <ul className="bulletList">
                    {product.highlights.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {product.inclusions.length > 0 ? (
                <section className="detailSection" aria-labelledby="inclusions-heading">
                  <h2 id="inclusions-heading" className="sectionHeading">
                    {t(locale, 'demo.detail.inclusionsHeading')}
                  </h2>
                  <ul className="bulletList">
                    {product.inclusions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {product.exclusions.length > 0 ? (
                <section className="detailSection" aria-labelledby="exclusions-heading">
                  <h2 id="exclusions-heading" className="sectionHeading">
                    {t(locale, 'demo.detail.exclusionsHeading')}
                  </h2>
                  <ul className="bulletList">
                    {product.exclusions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="detailSection" aria-labelledby="policy-heading">
                <h2 id="policy-heading" className="sectionHeading">
                  {t(locale, 'demo.detail.policyHeading')}
                </h2>
                <ul className="bulletList">
                  {policyLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            </div>
          </article>

          <TourAvailabilityQuote
            productId={product.id}
            locale={locale}
            timeZone={product.timeZone}
            initialFromDate={windowInfo.fromDate}
            initialToDate={windowInfo.toDate}
            initialHasNext={windowInfo.hasNext}
            initialDepartures={initialDepartures}
          />
        </div>
      </main>
    </>
  );
}
