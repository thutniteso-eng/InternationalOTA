'use client';

import { formatInstant, formatLocalDate, t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApiFetch, formatAdminMoneyMinor, type AdminBookingDetailDto } from '@/lib/admin-api';

export function AdminBookingDetailView({
  locale,
  booking,
}: {
  readonly locale: BuiltinLocale;
  readonly booking: AdminBookingDetailDto;
}): React.JSX.Element {
  return (
    <div className="adminStack">
      <p>
        <Link href={`/${locale}/admin/bookings`} className="secondaryButton">
          {t(locale, 'admin.bookingDetail.backToList')}
        </Link>
      </p>

      <section className="widgetCard">
        <div className="bookingCardTop">
          <h1 className="pageTitle">
            {t(locale, 'admin.bookingDetail.title', { reference: booking.reference })}
          </h1>
          <span className="statusChip statusChipPending">
            {t(locale, `demo.booking.status.${booking.status}`)}
          </span>
        </div>
        <p className="resultMeta">
          {formatLocalDate(booking.quoteSnapshot.localDate, locale)} ·{' '}
          {t(locale, 'demo.booking.guestsSummary', {
            adult: booking.pax.adult,
            child: booking.pax.child,
            infant: booking.pax.infant,
          })}{' '}
          ·{' '}
          <strong>
            {formatAdminMoneyMinor(booking.totalAmountMinor, booking.currency, locale)}
          </strong>
        </p>
        <p className="resultMeta">
          {t(locale, 'admin.bookingDetail.idLabel')} <code>{booking.id}</code>
          {booking.paymentRef ? (
            <>
              {' · '}
              {t(locale, 'admin.bookingDetail.pspRefLabel')} <code>{booking.paymentRef}</code>
            </>
          ) : null}
        </p>
      </section>

      <section className="widgetCard" data-testid="admin-booking-contact">
        <h2 className="sectionHeading">{t(locale, 'admin.bookingDetail.contactHeading')}</h2>
        <p>{booking.contactName}</p>
        <p>{booking.contactEmail}</p>
        <p>{booking.contactPhone}</p>
        <p className="resultMeta">
          {t(locale, 'admin.bookingDetail.localeLabel', { locale: booking.contactLocale })}
        </p>
      </section>

      <section className="widgetCard" data-testid="admin-booking-events">
        <h2 className="sectionHeading">{t(locale, 'admin.bookingDetail.eventsHeading')}</h2>
        {booking.events && booking.events.length > 0 ? (
          <ul className="adminList">
            {booking.events.map((ev) => (
              <li key={ev.id} className="adminListItem">
                <div>
                  <strong>
                    {ev.fromStatus ?? '∅'} → {ev.toStatus}
                  </strong>
                  {' · '}
                  <span className="resultMeta">
                    {formatInstant(ev.at, locale, 'Asia/Ho_Chi_Minh')}
                  </span>
                </div>
                <div className="resultMeta">
                  {t(locale, 'admin.bookingDetail.actorLabel', { actor: ev.actor })}
                  {ev.reason ? ` · ${ev.reason}` : ''}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="resultMeta">{t(locale, 'admin.bookingDetail.noEvents')}</p>
        )}
      </section>

      <section className="widgetCard" data-testid="admin-booking-attempts">
        <h2 className="sectionHeading">{t(locale, 'admin.bookingDetail.attemptsHeading')}</h2>
        {booking.attempts.length > 0 ? (
          <ul className="adminList">
            {booking.attempts.map((att) => (
              <li key={att.id} className="adminListItem">
                <div>
                  <strong>{att.provider}</strong> · <code>{att.status}</code> ·{' '}
                  {formatAdminMoneyMinor(att.amountMinor, att.currency, locale)}
                </div>
                <div className="resultMeta">
                  <code>{att.id}</code>
                  {att.providerRef ? ` · ${att.providerRef}` : ''}
                  {att.failureReason ? ` · ${att.failureReason}` : ''}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="resultMeta">{t(locale, 'admin.bookingDetail.noAttempts')}</p>
        )}
      </section>

      <section className="widgetCard" data-testid="admin-booking-refunds">
        <h2 className="sectionHeading">{t(locale, 'admin.bookingDetail.refundsHeading')}</h2>
        {booking.refunds.length > 0 ? (
          <ul className="adminList">
            {booking.refunds.map((ref) => (
              <li key={ref.id} className="adminListItem">
                <div>
                  <code>{ref.status}</code> ·{' '}
                  <strong>{formatAdminMoneyMinor(ref.amountMinor, ref.currency, locale)}</strong> ·{' '}
                  {ref.reason}
                </div>
                <div className="resultMeta">
                  <code>{ref.id}</code> ·{' '}
                  {t(locale, 'admin.bookingDetail.attemptsCount', { count: ref.attempts })}
                  {ref.lastError ? ` · ${ref.lastError}` : ''}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="resultMeta">{t(locale, 'admin.bookingDetail.noRefunds')}</p>
        )}
      </section>

      <section className="widgetCard" data-testid="admin-booking-emails">
        <h2 className="sectionHeading">{t(locale, 'admin.bookingDetail.emailsHeading')}</h2>
        {booking.emails.length > 0 ? (
          <ul className="adminList">
            {booking.emails.map((email) => (
              <li key={email.id} className="adminListItem">
                <div>
                  <code>{email.template}</code> ({email.locale}) · <strong>{email.status}</strong>
                </div>
                <div className="resultMeta">
                  {t(locale, 'admin.bookingDetail.attemptsCount', { count: email.attempts })}
                  {email.sentAt
                    ? ` · ${formatInstant(email.sentAt, locale, 'Asia/Ho_Chi_Minh')}`
                    : ''}
                  {email.lastError ? ` · ${email.lastError}` : ''}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="resultMeta">{t(locale, 'admin.bookingDetail.noEmails')}</p>
        )}
      </section>
    </div>
  );
}

export function AdminBookingDetailClient({
  locale,
  reference,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly reference: string;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const [booking, setBooking] = useState<AdminBookingDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setLoading(true);
      const res = await adminApiFetch<AdminBookingDetailDto>(
        `/api/admin/bookings/${encodeURIComponent(reference)}`,
        {},
        fetchFn,
      );
      if (!active) {
        return;
      }
      if (!res.ok) {
        setError(res.message ?? t(locale, 'admin.common.actionError'));
        setLoading(false);
        return;
      }
      setBooking(res.data);
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
    };
  }, [fetchFn, locale, reference]);

  if (loading) {
    return <p className="resultMeta">{t(locale, 'admin.common.loading')}</p>;
  }
  if (error || !booking) {
    return (
      <div className="errorBox" role="alert">
        {error ?? t(locale, 'admin.common.empty')}
      </div>
    );
  }

  return <AdminBookingDetailView locale={locale} booking={booking} />;
}
