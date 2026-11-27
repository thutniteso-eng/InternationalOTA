import { notFound } from 'next/navigation';
import { ReturnStatusClient } from '@/components/ReturnStatusClient';
import { SiteHeader } from '@/components/SiteHeader';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function BookingReturnPage({
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
          vi: `/vi/bookings/${encodedRef}/return`,
          en: `/en/bookings/${encodedRef}/return`,
        }}
      />
      <main className="pageMain">
        <ReturnStatusClient locale={locale} reference={reference} />
      </main>
    </>
  );
}
