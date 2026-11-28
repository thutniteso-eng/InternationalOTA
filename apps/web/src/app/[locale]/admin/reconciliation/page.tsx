import { notFound } from 'next/navigation';
import { AdminReconciliationListClient } from '@/components/admin/AdminReconciliationListClient';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminReconciliationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminReconciliationListClient locale={locale} />;
}
