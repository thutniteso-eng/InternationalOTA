import { notFound } from 'next/navigation';
import { BookingCheckoutClient } from '@/components/BookingCheckoutClient';
import { SiteHeader } from '@/components/SiteHeader';
import { isSupportedWebLocale } from '@/i18n/config';
import { normalizePaxSelection } from '@/lib/booking-api';

export const dynamic = 'force-dynamic';

export default async function BookDeparturePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; departureId: string }>;
  searchParams: Promise<{
    adult?: string;
    child?: string;
    infant?: string;
    productId?: string;
    slug?: string;
  }>;
}): Promise<React.JSX.Element> {
  const { locale, departureId } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  const sp = await searchParams;
  const pax = normalizePaxSelection({
    adult: sp.adult,
    child: sp.child,
    infant: sp.infant,
  });
  const productId = typeof sp.productId === 'string' ? sp.productId.trim() : '';
  const tourSlug = typeof sp.slug === 'string' ? sp.slug.trim() : '';

  const qs = new URLSearchParams({
    adult: String(pax.adult),
    child: String(pax.child),
    infant: String(pax.infant),
  });
  if (productId) {
    qs.set('productId', productId);
  }
  if (tourSlug) {
    qs.set('slug', tourSlug);
  }
  const suffix = `/book/${encodeURIComponent(departureId)}?${qs.toString()}`;

  return (
    <>
      <SiteHeader
        locale={locale}
        alternateHrefs={{
          vi: `/vi${suffix}`,
          en: `/en${suffix}`,
        }}
      />
      <main className="pageMain">
        <BookingCheckoutClient
          locale={locale}
          departureId={departureId}
          productId={productId}
          tourSlug={tourSlug}
          pax={pax}
        />
      </main>
    </>
  );
}
