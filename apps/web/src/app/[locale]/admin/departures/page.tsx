import { notFound } from 'next/navigation';
import { AdminDeparturesClient } from '@/components/admin/AdminDeparturesClient';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminDeparturesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminDeparturesClient locale={locale} />;
}
