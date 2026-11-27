'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchBrowserSession, signOutUser, type AuthSession } from '@/lib/auth-client';

export function dispatchAuthChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('ota:auth-changed'));
  }
}

export function HeaderAuthControls({
  locale,
}: {
  readonly locale: BuiltinLocale;
}): React.JSX.Element {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      const next = await fetchBrowserSession();
      if (active) {
        setSession(next);
        setLoaded(true);
      }
    }
    void load();

    function handleAuthEvent(): void {
      void load();
    }
    window.addEventListener('ota:auth-changed', handleAuthEvent);
    window.addEventListener('focus', handleAuthEvent);
    return () => {
      active = false;
      window.removeEventListener('ota:auth-changed', handleAuthEvent);
      window.removeEventListener('focus', handleAuthEvent);
    };
  }, []);

  async function handleSignOut(): Promise<void> {
    await signOutUser();
    setSession(null);
    dispatchAuthChanged();
    window.location.assign(`/${locale}`);
  }

  if (!loaded) {
    return (
      <div className="authNav">
        <Link href={`/${locale}/sign-in`} className="langLink">
          {t(locale, 'demo.nav.signIn')}
        </Link>
      </div>
    );
  }

  if (session) {
    return (
      <div className="authNav">
        <span className="authGreeting">
          {t(locale, 'demo.nav.signedInAs', { name: session.user.name })}
        </span>
        <Link href={`/${locale}/me/bookings`} className="langLink">
          {t(locale, 'demo.nav.myBookings')}
        </Link>
        <button
          type="button"
          className="langLink authSignOutBtn"
          onClick={() => {
            void handleSignOut();
          }}
        >
          {t(locale, 'demo.nav.signOut')}
        </button>
      </div>
    );
  }

  return (
    <div className="authNav">
      <Link href={`/${locale}/sign-in`} className="langLink">
        {t(locale, 'demo.nav.signIn')}
      </Link>
      <Link href={`/${locale}/sign-up`} className="langLink">
        {t(locale, 'demo.nav.signUp')}
      </Link>
    </div>
  );
}
