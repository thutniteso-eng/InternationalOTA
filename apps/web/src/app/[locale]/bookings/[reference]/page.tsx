import { notFound } from 'next/navigation';
import { BookingDetailClient } from '@/components/BookingDetailClient';
import { SiteHeader } from '@/components/SiteHeader';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function BookingDetailPage({
  params,
}: {
  params: Promise<{ locale: string; reference: string }>;
}): Promise<React.JSX.Element> {
  const { locale, reference } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  const encodedRef = encodeURIComponent(reference);
  return (
    <>
      <SiteHeader
        locale={locale}
        alternateHrefs={{
          vi: `/vi/bookings/${encodedRef}`,
          en: `/en/bookings/${encodedRef}`,
        }}
      />
      <main className="pageMain">
        <BookingDetailClient locale={locale} reference={reference} />
      </main>
    </>
  );
}
