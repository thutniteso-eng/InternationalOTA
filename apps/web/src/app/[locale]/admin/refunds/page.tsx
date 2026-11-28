import { notFound } from 'next/navigation';
import { AdminRefundsClient } from '@/components/admin/AdminRefundsClient';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminRefundsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminRefundsClient locale={locale} />;
}
