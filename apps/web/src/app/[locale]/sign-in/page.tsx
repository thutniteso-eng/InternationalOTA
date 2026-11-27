import { notFound } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { SiteHeader } from '@/components/SiteHeader';
import { isSupportedWebLocale } from '@/i18n/config';
import { sanitizeReturnTo } from '@/lib/auth-client';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isSupportedWebLocale(locale)) {
    notFound();
  }
  const sp = await searchParams;
  const rawReturnTo = typeof sp.returnTo === 'string' ? sp.returnTo : undefined;
  const querySuffix = rawReturnTo
    ? `?returnTo=${encodeURIComponent(sanitizeReturnTo(rawReturnTo, locale))}`
    : '';

  return (
    <>
      <SiteHeader
        locale={locale}
        alternateHrefs={{
          vi: `/vi/sign-in${querySuffix}`,
          en: `/en/sign-in${querySuffix}`,
        }}
      />
      <main className="pageMain authPageMain">
        <AuthForm locale={locale} mode="sign-in" rawReturnTo={rawReturnTo} />
      </main>
    </>
  );
}
