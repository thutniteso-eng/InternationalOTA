'use client';

import { formatInstant, t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  adminApiFetch,
  formatAdminMoneyMinor,
  type AdminBookingWindowStats,
  type AdminDashboardDto,
} from '@/lib/admin-api';
import type { BookingStatus } from '@/lib/booking-api';

const BOOKING_STATUS_ORDER: readonly BookingStatus[] = [
  'held',
  'payment_pending',
  'confirmed',
  'cancelled',
  'expired',
];

function WindowCard({
  title,
  stats,
  locale,
  testId,
}: {
  readonly title: string;
  readonly stats: AdminBookingWindowStats;
  readonly locale: BuiltinLocale;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <section className="widgetCard adminStatCard" data-testid={testId}>
      <h2 className="sectionHeading">{title}</h2>
      <p className="adminBigStat">
        {t(locale, 'admin.dashboard.totalBookings')}: <strong>{stats.totalBookings}</strong>
      </p>
      <dl className="adminStatusCounts">
        {BOOKING_STATUS_ORDER.map((status) => (
          <div key={status} className="adminMetricRow">
            <dt>{t(locale, `demo.booking.status.${status}`)}</dt>
            <dd>{stats.byStatus[status] ?? 0}</dd>
          </div>
        ))}
      </dl>
      <div className="adminRevenueBox">
        <h3 className="adminSubHeading">{t(locale, 'admin.dashboard.confirmedRevenue')}</h3>
        {stats.confirmedRevenueByCurrency.length === 0 ? (
          <p className="resultMeta">{t(locale, 'admin.dashboard.noRevenue')}</p>
        ) : (
          <ul className="adminRevenueList">
            {stats.confirmedRevenueByCurrency.map((rev) => (
              <li key={rev.currency}>
                <strong>{formatAdminMoneyMinor(rev.totalAmountMinor, rev.currency, locale)}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function AdminDashboardView({
  locale,
  data,
}: {
  readonly locale: BuiltinLocale;
  readonly data: AdminDashboardDto;
}): React.JSX.Element {
  const latest = data.latestReconciliation;
  return (
    <div className="adminStack">
      <section className="heroIntro">
        <h1 className="pageTitle">{t(locale, 'admin.dashboard.title')}</h1>
        <p className="pageSubtitle">{t(locale, 'admin.dashboard.subtitle')}</p>
      </section>

      <div className="adminGrid2">
        <WindowCard
          title={t(locale, 'admin.dashboard.todayTitle')}
          stats={data.today}
          locale={locale}
          testId="admin-dashboard-today"
        />
        <WindowCard
          title={t(locale, 'admin.dashboard.last7DaysTitle')}
          stats={data.last7Days}
          locale={locale}
          testId="admin-dashboard-7days"
        />
      </div>

      <div className="adminGrid2">
        <section className="widgetCard adminStatCard">
          <h2 className="sectionHeading">{t(locale, 'admin.dashboard.pendingRefundsTitle')}</h2>
          <p className="adminBigStat">
            <strong>{data.pendingRefundsCount}</strong>
          </p>
          <p>
            <Link href={`/${locale}/admin/refunds`} className="secondaryButton">
              {t(locale, 'admin.dashboard.pendingRefundsLink')}
            </Link>
          </p>
        </section>

        <section className="widgetCard adminStatCard" data-testid="admin-dashboard-recon">
          <h2 className="sectionHeading">{t(locale, 'admin.dashboard.reconTitle')}</h2>
          {latest ? (
            <>
              <p>
                <span
                  className={`statusChip ${latest.status === 'ok' ? 'statusChipConfirmed' : 'statusChipPending'}`}
                >
                  {t(locale, `admin.recon.status.${latest.status}`)}
                </span>
              </p>
              <p className="resultMeta">
                {t(locale, 'admin.dashboard.reconErrorsWarnings', {
                  errors: latest.counts.errors ?? 0,
                  warnings: latest.counts.warnings ?? 0,
                })}
              </p>
              <p className="resultMeta">
                {formatInstant(latest.startedAt, locale, 'Asia/Ho_Chi_Minh')}
              </p>
              <p>
                <Link
                  href={`/${locale}/admin/reconciliation/${encodeURIComponent(latest.id)}`}
                  className="secondaryButton"
                >
                  {t(locale, 'admin.dashboard.reconViewDetails')}
                </Link>
              </p>
            </>
          ) : (
            <>
              <p className="resultMeta">{t(locale, 'admin.dashboard.reconEmpty')}</p>
              <p>
                <Link href={`/${locale}/admin/reconciliation`} className="secondaryButton">
                  {t(locale, 'admin.dashboard.reconViewDetails')}
                </Link>
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function AdminDashboardClient({
  locale,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const [data, setData] = useState<AdminDashboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      const res = await adminApiFetch<AdminDashboardDto>('/api/admin/dashboard', {}, fetchFn);
      if (!active) {
        return;
      }
      if (!res.ok) {
        setError(res.message ?? t(locale, 'admin.common.actionError'));
        return;
      }
      setData(res.data);
    }
    void load();
    return () => {
      active = false;
    };
  }, [fetchFn, locale]);

  if (error) {
    return (
      <div className="errorBox" role="alert">
        {error}
      </div>
    );
  }
  if (!data) {
    return <p className="resultMeta">{t(locale, 'admin.common.loading')}</p>;
  }

  return <AdminDashboardView locale={locale} data={data} />;
}
