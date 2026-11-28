import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { isSupportedWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }

  return <AdminShell locale={locale}>{children}</AdminShell>;
}
