'use client';

import { formatInstant, t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  adminApiFetch,
  extractBookingReferenceFromFinding,
  type ReconciliationRunDetailDto,
} from '@/lib/admin-api';

export function AdminReconciliationDetailClient({
  locale,
  runId,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly runId: string;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const [detail, setDetail] = useState<ReconciliationRunDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setLoading(true);
      const res = await adminApiFetch<ReconciliationRunDetailDto>(
        `/api/admin/reconciliation/runs/${encodeURIComponent(runId)}`,
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
      setDetail(res.data);
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
    };
  }, [fetchFn, locale, runId]);

  if (loading) {
    return <p className="resultMeta">{t(locale, 'admin.common.loading')}</p>;
  }
  if (error || !detail) {
    return (
      <div className="errorBox" role="alert">
        {error ?? t(locale, 'admin.common.empty')}
      </div>
    );
  }

  const { run, groupedFindings } = detail;

  return (
    <div className="adminStack">
      <p>
        <Link href={`/${locale}/admin/reconciliation`} className="secondaryButton">
          {t(locale, 'admin.recon.backToRuns')}
        </Link>
      </p>

      <section className="widgetCard">
        <div className="bookingCardTop">
          <h1 className="pageTitle">{t(locale, 'admin.recon.detailTitle')}</h1>
          <span
            className={`statusChip ${run.status === 'ok' ? 'statusChipConfirmed' : 'statusChipPending'}`}
          >
            {t(locale, `admin.recon.status.${run.status}`)}
          </span>
        </div>
        <p className="resultMeta">
          <code>{run.id}</code> · {formatInstant(run.startedAt, locale, 'Asia/Ho_Chi_Minh')} ·{' '}
          {t(locale, 'admin.recon.triggeredBy', { actor: run.triggeredBy })}
        </p>
        <p className="resultMeta">
          {t(locale, 'admin.dashboard.reconErrorsWarnings', {
            errors: run.counts.errors ?? 0,
            warnings: run.counts.warnings ?? 0,
          })}
        </p>
      </section>

      {groupedFindings.length === 0 ? (
        <div className="successBox" role="status">
          {t(locale, 'admin.recon.noFindings')}
        </div>
      ) : (
        <div className="adminStack">
          {groupedFindings.map((group) => (
            <section key={group.code} className="widgetCard">
              <div className="bookingCardTop">
                <h2 className="sectionHeading">
                  <code>{group.code}</code> ({group.count})
                </h2>
                <span className="statusChip statusChipPending">
                  {t(locale, `admin.recon.severity.${group.severity}`)}
                </span>
              </div>
              <ul className="adminList">
                {group.items.map((item) => {
                  const ref = extractBookingReferenceFromFinding(item);
                  return (
                    <li key={item.id} className="adminListItem">
                      <div>
                        <code>{item.entityType}</code> · <code>{item.entityId}</code>
                        {ref ? (
                          <>
                            {' · '}
                            <Link href={`/${locale}/admin/bookings/${encodeURIComponent(ref)}`}>
                              {t(locale, 'admin.recon.openBooking', { reference: ref })}
                            </Link>
                          </>
                        ) : null}
                      </div>
                      <pre className="adminCodeJson">{JSON.stringify(item.details)}</pre>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
