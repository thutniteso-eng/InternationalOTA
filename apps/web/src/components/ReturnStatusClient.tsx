'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { resolveReturnViewState, type BookingDetailDto } from '@/lib/booking-api';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

export async function fetchReturnBookingDetail(
  reference: string,
  fetchFn: typeof fetch = fetch,
): Promise<
  | { readonly kind: 'ok'; readonly booking: BookingDetailDto }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'error' }
> {
  try {
    // Intentionally ignore URL query params; source of truth is strictly the API booking status.
    const res = await fetchFn(`/api/bookings/${encodeURIComponent(reference)}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (res.status === 401) {
      return { kind: 'unauthenticated' };
    }
    if (!res.ok) {
      return { kind: 'error' };
    }
    const booking = (await res.json()) as BookingDetailDto;
    return { kind: 'ok', booking };
  } catch {
    return { kind: 'error' };
  }
}

export function ReturnStatusView({
  locale,
  reference,
  booking,
  timedOut,
  onRetryCheck,
}: {
  readonly locale: BuiltinLocale;
  readonly reference: string;
  readonly booking: BookingDetailDto | null;
  readonly timedOut: boolean;
  readonly onRetryCheck?: () => void;
}): React.JSX.Element {
  const viewState = booking ? resolveReturnViewState(booking, timedOut) : null;

  return (
    <article className="widgetCard" aria-live="polite">
      <h1 className="pageTitle">{t(locale, 'demo.return.pageTitle')}</h1>

      {!booking || !viewState ? (
        <p className="resultMeta">
          {timedOut
            ? t(locale, 'demo.return.timedOutBody')
            : t(locale, 'demo.return.processingBody')}
        </p>
      ) : null}

      {viewState?.kind === 'confirmed' ? (
        <section className="successBox" data-testid="return-status-confirmed">
          <h2 className="sectionHeading">{t(locale, 'demo.return.confirmedTitle')}</h2>
          <p>{t(locale, 'demo.return.confirmedBody', { reference })}</p>
        </section>
      ) : null}

      {viewState?.kind === 'failed' ? (
        <section className="errorBox" data-testid="return-status-failed">
          <h2 className="sectionHeading">{t(locale, 'demo.return.failedTitle')}</h2>
          <p>
            {viewState.canRetry
              ? t(locale, 'demo.return.failedRetryBody')
              : t(locale, 'demo.return.failedExpiredBody')}
          </p>
        </section>
      ) : null}

      {viewState && (viewState.kind === 'processing' || viewState.kind === 'timed_out') ? (
        <section className="pendingBox" data-testid="return-status-processing">
          <h2 className="sectionHeading">{t(locale, 'demo.return.processingTitle')}</h2>
          <p>
            {viewState.kind === 'timed_out'
              ? t(locale, 'demo.return.timedOutBody')
              : t(locale, 'demo.return.processingBody')}
          </p>
        </section>
      ) : null}

      <div className="panelActions">
        <Link
          href={`/${locale}/bookings/${encodeURIComponent(reference)}`}
          className="primaryButton"
        >
          {viewState?.kind === 'failed' && viewState.canRetry
            ? t(locale, 'demo.return.retryPay')
            : t(locale, 'demo.return.viewBooking')}
        </Link>

        {onRetryCheck ? (
          <button type="button" className="secondaryButton" onClick={onRetryCheck}>
            {t(locale, 'demo.return.checkAgain')}
          </button>
        ) : null}

        <Link href={`/${locale}/me/bookings`} className="secondaryButton">
          {t(locale, 'demo.nav.myBookings')}
        </Link>
      </div>
    </article>
  );
}

export function ReturnStatusClient({
  locale,
  reference,
}: {
  readonly locale: BuiltinLocale;
  readonly reference: string;
}): React.JSX.Element {
  const [booking, setBooking] = useState<BookingDetailDto | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const pollOnce = useCallback(async (): Promise<BookingDetailDto | null> => {
    const result = await fetchReturnBookingDetail(reference);
    if (result.kind === 'unauthenticated') {
      window.location.assign(
        `/${locale}/sign-in?returnTo=${encodeURIComponent(`/${locale}/bookings/${reference}/return`)}`,
      );
      return null;
    }
    if (result.kind === 'error') {
      return null;
    }
    setBooking(result.booking);
    return result.booking;
  }, [locale, reference]);

  useEffect(() => {
    let cancelled = false;
    const startMs = Date.now();
    let timerId: number | undefined;

    async function cycle(): Promise<void> {
      const latest = await pollOnce();
      if (cancelled) {
        return;
      }
      const elapsed = Date.now() - startMs;
      if (latest) {
        const view = resolveReturnViewState(latest, false);
        if (view.kind === 'confirmed' || view.kind === 'failed') {
          return;
        }
      }
      if (elapsed >= POLL_TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      timerId = window.setTimeout(() => {
        void cycle();
      }, POLL_INTERVAL_MS);
    }

    void cycle();
    return () => {
      cancelled = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [pollOnce]);

  return (
    <ReturnStatusView
      locale={locale}
      reference={reference}
      booking={booking}
      timedOut={timedOut}
      onRetryCheck={() => {
        setTimedOut(false);
        void pollOnce();
      }}
    />
  );
}
