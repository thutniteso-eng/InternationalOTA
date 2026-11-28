'use client';

import { formatInstant, t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  adminApiFetch,
  createAdminIdempotencyKey,
  type ReconciliationRunDetailDto,
  type ReconciliationRunDto,
  type ReconciliationRunListResponse,
} from '@/lib/admin-api';

export function AdminReconciliationListClient({
  locale,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const [runs, setRuns] = useState<readonly ReconciliationRunDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningNow, setRunningNow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(
    async (cursor?: string | null) => {
      if (!cursor) {
        setLoading(true);
      }
      setError(null);
      const url = `/api/admin/reconciliation/runs?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await adminApiFetch<ReconciliationRunListResponse>(url, {}, fetchFn);
      if (!res.ok) {
        setError(res.message ?? t(locale, 'admin.common.actionError'));
        setLoading(false);
        return;
      }
      if (cursor) {
        setRuns((prev) => [...prev, ...res.data.items]);
      } else {
        setRuns(res.data.items);
      }
      setNextCursor(res.data.nextCursor);
      setLoading(false);
    },
    [fetchFn, locale],
  );

  useEffect(() => {
    void loadRuns(null);
  }, [loadRuns]);

  async function handleRunNow(): Promise<void> {
    setRunningNow(true);
    setError(null);
    const res = await adminApiFetch<ReconciliationRunDetailDto>(
      '/api/admin/reconciliation/runs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createAdminIdempotencyKey('recon-run'),
        },
        body: JSON.stringify({ reason: 'admin_console_manual_run' }),
      },
      fetchFn,
    );
    setRunningNow(false);
    if (!res.ok) {
      if (res.status === 409) {
        setError(t(locale, 'admin.recon.alreadyRunningError'));
      } else {
        setError(res.message ?? t(locale, 'admin.common.actionError'));
      }
      return;
    }
    await loadRuns(null);
  }

  return (
    <div className="adminStack">
      <section className="heroIntro">
        <h1 className="pageTitle">{t(locale, 'admin.recon.title')}</h1>
        <p className="pageSubtitle">{t(locale, 'admin.recon.subtitle')}</p>
      </section>

      <div className="panelActions">
        <button
          type="button"
          className="primaryButton"
          disabled={runningNow}
          onClick={() => {
            void handleRunNow();
          }}
        >
          {runningNow ? t(locale, 'admin.recon.runningNow') : t(locale, 'admin.recon.runNowButton')}
        </button>
      </div>

      {error ? (
        <div className="errorBox" role="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="resultMeta">{t(locale, 'admin.common.loading')}</p>
      ) : runs.length === 0 ? (
        <div className="emptyState">{t(locale, 'admin.common.empty')}</div>
      ) : (
        <div className="adminStack">
          {runs.map((run) => (
            <article key={run.id} className="widgetCard">
              <div className="bookingCardTop">
                <strong>{formatInstant(run.startedAt, locale, 'Asia/Ho_Chi_Minh')}</strong>
                <span
                  className={`statusChip ${run.status === 'ok' ? 'statusChipConfirmed' : 'statusChipPending'}`}
                >
                  {t(locale, `admin.recon.status.${run.status}`)}
                </span>
              </div>
              <p className="resultMeta">
                {t(locale, 'admin.dashboard.reconErrorsWarnings', {
                  errors: run.counts.errors ?? 0,
                  warnings: run.counts.warnings ?? 0,
                })}{' '}
                · {t(locale, 'admin.recon.triggeredBy', { actor: run.triggeredBy })}
              </p>
              <div className="panelActions">
                <Link
                  href={`/${locale}/admin/reconciliation/${encodeURIComponent(run.id)}`}
                  className="secondaryButton"
                >
                  {t(locale, 'admin.recon.viewRun')}
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}

      {nextCursor ? (
        <div className="loadMoreRow">
          <button
            type="button"
            className="secondaryButton"
            onClick={() => {
              void loadRuns(nextCursor);
            }}
          >
            {t(locale, 'admin.common.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
