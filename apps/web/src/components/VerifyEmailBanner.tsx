'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import { useState } from 'react';
import { resendVerificationEmail } from '@/lib/auth-client';

export function VerifyEmailBanner({
  locale,
  email,
}: {
  readonly locale: BuiltinLocale;
  readonly email: string;
}): React.JSX.Element {
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleResend(): Promise<void> {
    setSending(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const callbackUrl = typeof window !== 'undefined' ? window.location.pathname : `/${locale}`;
      const res = await resendVerificationEmail(email, callbackUrl);
      if (res.ok) {
        setStatusMessage(t(locale, 'demo.auth.resendSent'));
        setIsError(false);
      } else if (res.rateLimited) {
        setStatusMessage(t(locale, 'demo.auth.rateLimited'));
        setIsError(true);
      } else {
        setStatusMessage(res.message ?? t(locale, 'demo.auth.resendError'));
        setIsError(true);
      }
    } catch {
      setStatusMessage(t(locale, 'demo.auth.resendError'));
      setIsError(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="verifyBanner" aria-live="polite">
      <div className="verifyBannerText">
        <strong className="verifyBannerTitle">{t(locale, 'demo.auth.verifyBannerTitle')}</strong>
        <p className="verifyBannerBody">{t(locale, 'demo.auth.verifyBannerBody', { email })}</p>
        {statusMessage ? (
          <p className={isError ? 'verifyBannerError' : 'verifyBannerSuccess'}>{statusMessage}</p>
        ) : null}
      </div>
      <button
        type="button"
        className="secondaryButton"
        disabled={sending}
        onClick={() => {
          void handleResend();
        }}
      >
        {sending ? t(locale, 'demo.auth.resendSending') : t(locale, 'demo.auth.resendButton')}
      </button>
    </section>
  );
}
