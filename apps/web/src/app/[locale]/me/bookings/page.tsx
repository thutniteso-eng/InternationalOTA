import { notFound } from 'next/navigation';
import { MyBookingsClient } from '@/components/MyBookingsClient';
import { SiteHeader } from '@/components/SiteHeader';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function MyBookingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return (
    <>
      <SiteHeader
        locale={locale}
        alternateHrefs={{
          vi: '/vi/me/bookings',
          en: '/en/me/bookings',
        }}
      />
      <main className="pageMain">
        <MyBookingsClient locale={locale} />
      </main>
    </>
  );
}
