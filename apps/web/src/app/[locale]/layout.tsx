import { t } from '@internationalota/i18n';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  buildHreflangAlternates,
  isSupportedWebLocale,
  SUPPORTED_WEB_LOCALES,
} from '@/i18n/config';

export function generateStaticParams(): Array<{ locale: string }> {
  return SUPPORTED_WEB_LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    return {};
  }

  return {
    title: t(locale, 'home.title'),
    description: t(locale, 'home.subtitle'),
    alternates: buildHreflangAlternates(locale),
  };
}

export default async function LocaleLayout({
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

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
