import { notFound } from 'next/navigation';
import { AdminReconciliationDetailClient } from '@/components/admin/AdminReconciliationDetailClient';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminReconciliationDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<React.JSX.Element> {
  const { locale, id } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminReconciliationDetailClient locale={locale} runId={id} />;
}
