import { notFound } from 'next/navigation';
import { AdminBookingsClient } from '@/components/admin/AdminBookingsClient';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminBookingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminBookingsClient locale={locale} />;
}
