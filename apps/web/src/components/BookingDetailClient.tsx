'use client';

import {
  formatCancellationPolicySentences,
  formatInstant,
  t,
  type BuiltinLocale,
} from '@internationalota/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CancelConfirmPanel } from '@/components/CancelConfirmPanel';
import { VerifyEmailBanner } from '@/components/VerifyEmailBanner';
import { fetchBrowserSession, type AuthSession } from '@/lib/auth-client';
import {
  computeHoldCountdown,
  formatExactMinor,
  generateIdempotencyKey,
  type BookingCancellationPreviewDto,
  type BookingDetailDto,
  type InitiateCheckoutResponseDto,
} from '@/lib/booking-api';

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'confirmed':
      return 'statusChip statusChipConfirmed';
    case 'cancelled':
    case 'expired':
      return 'statusChip statusChipMuted';
    default:
      return 'statusChip statusChipPending';
  }
}

export function BookingDetailClient({
  locale,
  reference,
}: {
  readonly locale: BuiltinLocale;
  readonly reference: string;
}): React.JSX.Element {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booking, setBooking] = useState<BookingDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowTickMs, setNowTickMs] = useState(() => Date.now());

  const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const [cancelPanelOpen, setCancelPanelOpen] = useState(false);
  const [cancelPreview, setCancelPreview] = useState<BookingCancellationPreviewDto | null>(null);
  const [cancelPreviewLoading, setCancelPreviewLoading] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelDoneNotice, setCancelDoneNotice] = useState(false);

  const loadState = useCallback(async (): Promise<void> => {
    try {
      const [sess, res] = await Promise.all([
        fetchBrowserSession(),
        fetch(`/api/bookings/${encodeURIComponent(reference)}`, {
          credentials: 'include',
          cache: 'no-store',
        }),
      ]);
      setSession(sess);
      if (res.status === 401) {
        window.location.assign(
          `/${locale}/sign-in?returnTo=${encodeURIComponent(`/${locale}/bookings/${reference}`)}`,
        );
        return;
      }
      if (!res.ok) {
        setNotFound(true);
        setBooking(null);
        return;
      }
      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        const parsedServerMs = Date.parse(dateHeader);
        if (Number.isFinite(parsedServerMs)) {
          setServerOffsetMs(parsedServerMs - Date.now());
        }
      }
      const detail = (await res.json()) as BookingDetailDto;
      setBooking(detail);
      setNotFound(false);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [locale, reference]);

  useEffect(() => {
    void loadState();

    function handleFocus(): void {
      void loadState();
    }
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [loadState]);

  useEffect(() => {
    if (!booking || (booking.status !== 'held' && booking.status !== 'payment_pending')) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowTickMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [booking]);

  async function handlePayNow(): Promise<void> {
    if (!booking) {
      return;
    }
    setCheckoutSubmitting(true);
    setCheckoutError(null);
    try {
      const res = await fetch(`/api/bookings/${encodeURIComponent(booking.reference)}/checkout`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': generateIdempotencyKey(),
        },
        body: JSON.stringify({
          returnUrl: `/${locale}/bookings/${booking.reference}/return`,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        setCheckoutError(body?.detail ?? t(locale, 'demo.booking.checkoutError'));
        return;
      }
      const checkout = (await res.json()) as InitiateCheckoutResponseDto;
      window.location.assign(checkout.redirectUrl);
    } catch {
      setCheckoutError(t(locale, 'demo.booking.checkoutError'));
    } finally {
      setCheckoutSubmitting(false);
    }
  }

  async function handleOpenCancel(): Promise<void> {
    if (!booking) {
      return;
    }
    setCancelPanelOpen(true);
    setCancelPreviewLoading(true);
    setCancelError(null);
    try {
      const res = await fetch(
        `/api/bookings/${encodeURIComponent(booking.reference)}/cancellation-preview`,
        {
          credentials: 'include',
          cache: 'no-store',
        },
      );
      if (!res.ok) {
        setCancelError(t(locale, 'demo.booking.cancelError'));
        return;
      }
      const data = (await res.json()) as BookingCancellationPreviewDto;
      setCancelPreview(data);
    } catch {
      setCancelError(t(locale, 'demo.booking.cancelError'));
    } finally {
      setCancelPreviewLoading(false);
    }
  }

  async function handleConfirmCancel(): Promise<void> {
    if (!booking) {
      return;
    }
    setCancelSubmitting(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/bookings/${encodeURIComponent(booking.reference)}/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': generateIdempotencyKey(),
        },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        setCancelError(body?.detail ?? t(locale, 'demo.booking.cancelError'));
        return;
      }
      setCancelPanelOpen(false);
      setCancelDoneNotice(true);
      await loadState();
    } catch {
      setCancelError(t(locale, 'demo.booking.cancelError'));
    } finally {
      setCancelSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="widgetCard" aria-live="polite">
        <p className="resultMeta">{t(locale, 'demo.detail.quoteLoading')}</p>
      </div>
    );
  }

  if (notFound || !booking) {
    return (
      <div className="widgetCard">
        <h1 className="pageTitle">{t(locale, 'demo.booking.pageTitle', { reference })}</h1>
        <div className="errorBox" role="alert">
          {t(locale, 'demo.booking.notFound')}
        </div>
        <Link href={`/${locale}/me/bookings`} className="secondaryButton">
          {t(locale, 'demo.nav.myBookings')}
        </Link>
      </div>
    );
  }

  const isEmailVerified = session?.user.emailVerified ?? false;
  const isHoldActiveStatus = booking.status === 'held' || booking.status === 'payment_pending';
  const countdown = computeHoldCountdown(booking.holdExpiresAt, nowTickMs + serverOffsetMs);
  const canPay = isHoldActiveStatus && !countdown.expired && isEmailVerified;
  const canCancel =
    booking.status === 'held' ||
    booking.status === 'payment_pending' ||
    booking.status === 'confirmed';

  const policySentences = formatCancellationPolicySentences(
    {
      rules: booking.quoteSnapshot.rules,
      weatherClause: booking.quoteSnapshot.weatherClause,
    },
    locale,
  );

  return (
    <div className="bookLayout">
      {session && !isEmailVerified ? (
        <VerifyEmailBanner locale={locale} email={session.user.email} />
      ) : null}

      <div className="backRow">
        <Link href={`/${locale}/me/bookings`} className="backLink">
          {t(locale, 'demo.nav.myBookings')}
        </Link>
      </div>

      <article className="widgetCard">
        <div className="bookingHeaderRow">
          <h1 className="pageTitle">
            {t(locale, 'demo.booking.pageTitle', { reference: booking.reference })}
          </h1>
          <span className={statusBadgeClass(booking.status)} data-testid="booking-status-badge">
            {t(locale, `demo.booking.status.${booking.status}`)}
          </span>
        </div>

        {cancelDoneNotice ? (
          <div className="successBox" role="status">
            {t(locale, 'demo.booking.cancelSuccess')}
          </div>
        ) : null}

        {isHoldActiveStatus ? (
          <div className="countdownBox" aria-live="polite" data-testid="hold-countdown">
            <span className="countdownLabel">{t(locale, 'demo.booking.countdownLabel')}</span>
            <strong className="countdownValue">
              {countdown.expired ? t(locale, 'demo.booking.countdownExpired') : countdown.formatted}
            </strong>
          </div>
        ) : null}

        <dl className="factsList">
          <div>
            <dt>{t(locale, 'demo.booking.referenceLabel')}</dt>
            <dd>{booking.reference}</dd>
          </div>
          <div>
            <dt>{t(locale, 'demo.booking.departureLabel')}</dt>
            <dd>{formatInstant(booking.quoteSnapshot.startsAt, locale, 'Asia/Ho_Chi_Minh')}</dd>
          </div>
          <div>
            <dt>{t(locale, 'demo.booking.contactLabel')}</dt>
            <dd>
              {booking.contactName} ({booking.contactEmail})
            </dd>
          </div>
          <div>
            <dt>{t(locale, 'demo.detail.quoteTotal')}</dt>
            <dd>{formatExactMinor(booking.totalAmountMinor, booking.currency, locale)}</dd>
          </div>
        </dl>

        <div className="quoteBreakdown">
          {booking.quoteSnapshot.lines.map((line) => (
            <div key={line.paxType} className="quoteLineRow">
              <span>
                {t(locale, 'demo.detail.quoteLine', {
                  paxLabel: t(locale, `demo.detail.pax.${line.paxType}`),
                  quantity: line.quantity,
                })}
              </span>
              <span>{formatExactMinor(line.lineAmountMinor, booking.currency, locale)}</span>
            </div>
          ))}
          <div className="quoteTotalRow">
            <span>{t(locale, 'demo.detail.quoteTotal')}</span>
            <span>{formatExactMinor(booking.totalAmountMinor, booking.currency, locale)}</span>
          </div>
        </div>

        {booking.refund ? (
          <section className="refundBox" aria-live="polite" data-testid="refund-status-box">
            <h2 className="sectionHeading">{t(locale, 'demo.booking.refundStatusHeading')}</h2>
            <p className="refundLine">
              {t(locale, 'demo.booking.refundAmountLine', {
                amount: formatExactMinor(booking.refund.amountMinor, booking.currency, locale),
              })}
            </p>
            <span
              className={statusBadgeClass(
                booking.refund.status === 'succeeded' ? 'confirmed' : 'held',
              )}
            >
              {t(locale, `demo.booking.refundStatus.${booking.refund.status}`)}
            </span>
          </section>
        ) : null}

        {checkoutError ? (
          <div className="errorBox" role="alert">
            {checkoutError}
          </div>
        ) : null}

        {isHoldActiveStatus ? (
          <div className="actionBlock">
            <button
              type="button"
              className="primaryButton bookButton"
              disabled={!canPay || checkoutSubmitting}
              onClick={() => {
                void handlePayNow();
              }}
            >
              {checkoutSubmitting
                ? t(locale, 'demo.booking.startingCheckout')
                : t(locale, 'demo.booking.payNow')}
            </button>
            {!isEmailVerified ? (
              <p className="quoteMetaNote">{t(locale, 'demo.booking.payDisabledUnverified')}</p>
            ) : null}
          </div>
        ) : null}

        {canCancel && !cancelPanelOpen ? (
          <div className="actionBlock">
            <button
              type="button"
              className="secondaryButton"
              onClick={() => {
                void handleOpenCancel();
              }}
            >
              {t(locale, 'demo.booking.cancelButton')}
            </button>
          </div>
        ) : null}

        {cancelPanelOpen ? (
          <CancelConfirmPanel
            locale={locale}
            preview={cancelPreview}
            loadingPreview={cancelPreviewLoading}
            submitting={cancelSubmitting}
            errorMessage={cancelError}
            onConfirm={() => {
              void handleConfirmCancel();
            }}
            onKeep={() => {
              setCancelPanelOpen(false);
            }}
          />
        ) : null}

        <section className="detailSection" aria-labelledby="booking-policy-heading">
          <h2 id="booking-policy-heading" className="sectionHeading">
            {t(locale, 'demo.detail.policyHeading')}
          </h2>
          <ul className="bulletList">
            {policySentences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </article>
    </div>
  );
}
