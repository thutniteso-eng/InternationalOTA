import { notFound } from 'next/navigation';
import { AdminDashboardClient } from '@/components/admin/AdminDashboardClient';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminDashboardClient locale={locale} />;
}
