import { notFound } from 'next/navigation';
import { AdminBookingDetailClient } from '@/components/admin/AdminBookingDetailClient';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminBookingDetailPage({
  params,
}: {
  params: Promise<{ locale: string; reference: string }>;
}): Promise<React.JSX.Element> {
  const { locale, reference } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminBookingDetailClient locale={locale} reference={reference} />;
}
