'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { SiteHeader } from '@/components/SiteHeader';
import { adminApiFetch, type AdminDashboardDto } from '@/lib/admin-api';

function buildAdminAlternateHrefs(pathname: string | null): Partial<Record<BuiltinLocale, string>> {
  if (!pathname) {
    return { vi: '/vi/admin', en: '/en/admin' };
  }
  const rest = pathname.replace(/^\/(vi|en)(?=\/|$)/, '') || '/admin';
  return {
    vi: `/vi${rest}`,
    en: `/en${rest}`,
  };
}

export function AdminShell({
  locale,
  children,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly children: ReactNode;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const [authState, setAuthState] = useState<'loading' | 'allowed' | 'forbidden'>('loading');

  useEffect(() => {
    let active = true;
    async function checkAccess(): Promise<void> {
      const res = await adminApiFetch<AdminDashboardDto>('/api/admin/dashboard', {}, fetchFn);
      if (!active) {
        return;
      }
      if (res.ok) {
        setAuthState('allowed');
        return;
      }
      if (res.status === 401) {
        const target = pathname && pathname.startsWith('/') ? pathname : `/${locale}/admin`;
        router.replace(`/${locale}/sign-in?returnTo=${encodeURIComponent(target)}`);
        return;
      }
      setAuthState('forbidden');
    }
    void checkAccess();
    return () => {
      active = false;
    };
  }, [fetchFn, locale, pathname, router]);

  const navLinks = [
    { href: `/${locale}/admin`, label: t(locale, 'admin.nav.dashboard'), exact: true },
    { href: `/${locale}/admin/bookings`, label: t(locale, 'admin.nav.bookings'), exact: false },
    { href: `/${locale}/admin/refunds`, label: t(locale, 'admin.nav.refunds'), exact: false },
    { href: `/${locale}/admin/departures`, label: t(locale, 'admin.nav.departures'), exact: false },
    {
      href: `/${locale}/admin/reconciliation`,
      label: t(locale, 'admin.nav.reconciliation'),
      exact: false,
    },
  ];

  return (
    <>
      <SiteHeader locale={locale} alternateHrefs={buildAdminAlternateHrefs(pathname)} />
      <nav className="adminNavBar" aria-label={t(locale, 'admin.nav.title')}>
        <div className="adminNavInner">
          <span className="adminNavBrand">{t(locale, 'admin.nav.title')}</span>
          <div className="adminNavLinks">
            {navLinks.map((item) => {
              const isActive = item.exact
                ? pathname === item.href
                : Boolean(pathname?.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={isActive ? 'adminNavLink adminNavLinkActive' : 'adminNavLink'}
                >
                  {item.label}
                </Link>
              );
            })}
            <Link href={`/${locale}`} className="adminNavLink">
              {t(locale, 'admin.nav.storefront')}
            </Link>
          </div>
        </div>
      </nav>
      <main className="pageMain">
        {authState === 'loading' ? (
          <p className="resultMeta" data-testid="admin-auth-loading">
            {t(locale, 'admin.auth.loading')}
          </p>
        ) : authState === 'forbidden' ? (
          <section className="errorBox" role="alert" data-testid="admin-auth-forbidden">
            <h1 className="pageTitle">{t(locale, 'admin.auth.forbiddenTitle')}</h1>
            <p className="pageSubtitle">{t(locale, 'admin.auth.forbiddenBody')}</p>
            <p>
              <Link href={`/${locale}`} className="secondaryButton">
                {t(locale, 'admin.auth.backHome')}
              </Link>
            </p>
          </section>
        ) : (
          children
        )}
      </main>
    </>
  );
}
