'use client';

import { formatLocalDate, t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { VerifyEmailBanner } from '@/components/VerifyEmailBanner';
import { fetchBrowserSession, type AuthSession } from '@/lib/auth-client';
import {
  formatExactMinor,
  type BookingDetailDto,
  type CustomerBookingListResponse,
} from '@/lib/booking-api';

function chipClassForStatus(status: string): string {
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

export function MyBookingsClient({
  locale,
}: {
  readonly locale: BuiltinLocale;
}): React.JSX.Element {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [items, setItems] = useState<readonly BookingDetailDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unauthenticated, setUnauthenticated] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadInitial(): Promise<void> {
      setLoading(true);
      const sess = await fetchBrowserSession();
      if (!active) {
        return;
      }
      setSession(sess);
      const res = await fetch('/api/me/bookings?limit=20', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!active) {
        return;
      }
      if (res.status === 401) {
        setUnauthenticated(true);
        setLoading(false);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as CustomerBookingListResponse;
        setItems(data.items);
        setNextCursor(data.nextCursor);
      }
      setLoading(false);
    }
    void loadInitial();
    return () => {
      active = false;
    };
  }, []);

  async function handleLoadMore(): Promise<void> {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/me/bookings?limit=20&cursor=${encodeURIComponent(nextCursor)}`,
        {
          credentials: 'include',
          cache: 'no-store',
        },
      );
      if (res.ok) {
        const data = (await res.json()) as CustomerBookingListResponse;
        setItems((prev) => [...prev, ...data.items]);
        setNextCursor(data.nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="bookLayout">
      {session && !session.user.emailVerified ? (
        <VerifyEmailBanner locale={locale} email={session.user.email} />
      ) : null}

      <section className="heroIntro">
        <h1 className="pageTitle">{t(locale, 'demo.myBookings.pageTitle')}</h1>
        <p className="pageSubtitle">{t(locale, 'demo.myBookings.subtitle')}</p>
      </section>

      {loading ? <p className="resultMeta">{t(locale, 'demo.detail.quoteLoading')}</p> : null}

      {!loading && unauthenticated ? (
        <div className="widgetCard">
          <p className="resultMeta">{t(locale, 'demo.myBookings.signInPrompt')}</p>
          <Link
            href={`/${locale}/sign-in?returnTo=${encodeURIComponent(`/${locale}/me/bookings`)}`}
            className="primaryButton"
          >
            {t(locale, 'demo.nav.signIn')}
          </Link>
        </div>
      ) : null}

      {!loading && !unauthenticated && items.length === 0 ? (
        <div className="emptyState">
          <h2>{t(locale, 'demo.myBookings.emptyTitle')}</h2>
          <p>{t(locale, 'demo.myBookings.emptyHint')}</p>
          <Link href={`/${locale}`} className="primaryButton">
            {t(locale, 'demo.myBookings.exploreCta')}
          </Link>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="bookingListGrid">
          {items.map((item) => (
            <article key={item.id} className="bookingSummaryCard">
              <div className="bookingCardTop">
                <h2 className="cardTitle">
                  <Link href={`/${locale}/bookings/${encodeURIComponent(item.reference)}`}>
                    {item.reference}
                  </Link>
                </h2>
                <span className={chipClassForStatus(item.status)}>
                  {t(locale, `demo.booking.status.${item.status}`)}
                </span>
              </div>
              <p className="resultMeta">
                {formatLocalDate(item.quoteSnapshot.localDate, locale)} ·{' '}
                {t(locale, 'demo.booking.guestsSummary', {
                  adult: item.pax.adult,
                  child: item.pax.child,
                  infant: item.pax.infant,
                })}
              </p>
              <div className="cardFooter">
                <span className="cardPrice">
                  {formatExactMinor(item.totalAmountMinor, item.currency, locale)}
                </span>
                <Link
                  href={`/${locale}/bookings/${encodeURIComponent(item.reference)}`}
                  className="secondaryButton"
                >
                  {t(locale, 'demo.myBookings.viewDetails')}
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {nextCursor ? (
        <div className="loadMoreRow">
          <button
            type="button"
            className="secondaryButton"
            disabled={loadingMore}
            onClick={() => {
              void handleLoadMore();
            }}
          >
            {loadingMore
              ? t(locale, 'demo.auth.submitting')
              : t(locale, 'demo.myBookings.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
