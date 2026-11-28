'use client';

import { formatInstant, t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  adminApiFetch,
  createAdminIdempotencyKey,
  formatAdminMoneyMinor,
  type AdminRefundListResponse,
  type AdminRefundWithBookingDto,
} from '@/lib/admin-api';

export function AdminRefundsClient({
  locale,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const [statusFilter, setStatusFilter] = useState<'manual_review,failed' | 'all'>(
    'manual_review,failed',
  );
  const [items, setItems] = useState<readonly AdminRefundWithBookingDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [pendingRetryId, setPendingRetryId] = useState<string | null>(null);
  const [retryReason, setRetryReason] = useState('');
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const loadRefunds = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await adminApiFetch<AdminRefundListResponse>(
      `/api/admin/refunds?status=${encodeURIComponent(statusFilter)}&limit=50`,
      {},
      fetchFn,
    );
    if (!res.ok) {
      setError(res.message ?? t(locale, 'admin.common.actionError'));
      setLoading(false);
      return;
    }
    setItems(res.data.items);
    setLoading(false);
  }, [fetchFn, locale, statusFilter]);

  useEffect(() => {
    void loadRefunds();
  }, [loadRefunds]);

  async function handleConfirmRetry(refundId: string): Promise<void> {
    const trimmed = retryReason.trim();
    if (!trimmed) {
      setRetryError(t(locale, 'admin.common.reasonRequiredError'));
      return;
    }
    setSubmittingId(refundId);
    setRetryError(null);
    const res = await adminApiFetch(
      `/api/admin/refunds/${encodeURIComponent(refundId)}/retry`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createAdminIdempotencyKey('refund-retry'),
        },
        body: JSON.stringify({ reason: trimmed }),
      },
      fetchFn,
    );
    setSubmittingId(null);
    if (!res.ok) {
      setRetryError(res.message ?? t(locale, 'admin.common.actionError'));
      return;
    }
    setPendingRetryId(null);
    setRetryReason('');
    setSuccessMsg(t(locale, 'admin.refunds.retrySuccess', { id: refundId }));
    await loadRefunds();
  }

  return (
    <div className="adminStack">
      <section className="heroIntro">
        <h1 className="pageTitle">{t(locale, 'admin.refunds.title')}</h1>
        <p className="pageSubtitle">{t(locale, 'admin.refunds.subtitle')}</p>
      </section>

      <div className="panelActions">
        <button
          type="button"
          className={statusFilter === 'manual_review,failed' ? 'primaryButton' : 'secondaryButton'}
          onClick={() => setStatusFilter('manual_review,failed')}
        >
          {t(locale, 'admin.refunds.filterManualAndFailed')}
        </button>
        <button
          type="button"
          className={statusFilter === 'all' ? 'primaryButton' : 'secondaryButton'}
          onClick={() => setStatusFilter('all')}
        >
          {t(locale, 'admin.refunds.filterAll')}
        </button>
      </div>

      {successMsg ? (
        <div className="successBox" role="status">
          {successMsg}
        </div>
      ) : null}
      {error ? (
        <div className="errorBox" role="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="resultMeta">{t(locale, 'admin.common.loading')}</p>
      ) : items.length === 0 ? (
        <div className="emptyState">{t(locale, 'admin.common.empty')}</div>
      ) : (
        <div className="adminStack">
          {items.map((refund) => (
            <article key={refund.id} className="widgetCard">
              <div className="bookingCardTop">
                <strong>
                  {formatAdminMoneyMinor(refund.amountMinor, refund.currency, locale)}
                </strong>
                <span className="statusChip statusChipPending">{refund.status}</span>
              </div>
              <p className="resultMeta">
                <code>{refund.id}</code> · {refund.reason} ·{' '}
                {formatInstant(refund.createdAt, locale, 'Asia/Ho_Chi_Minh')}
              </p>
              {refund.bookingReference ? (
                <p>
                  <Link
                    href={`/${locale}/admin/bookings/${encodeURIComponent(refund.bookingReference)}`}
                  >
                    {refund.bookingReference}
                  </Link>
                </p>
              ) : null}
              {refund.lastError ? <p className="resultMeta">{refund.lastError}</p> : null}

              {refund.status === 'manual_review' ? (
                pendingRetryId === refund.id ? (
                  <section className="cancelConfirmPanel" aria-live="polite">
                    <h2 className="sectionHeading">{t(locale, 'admin.refunds.confirmTitle')}</h2>
                    <label className="adminFieldLabel">
                      <span>{t(locale, 'admin.common.reasonLabel')}</span>
                      <input
                        type="text"
                        className="adminInput"
                        value={retryReason}
                        onChange={(e) => setRetryReason(e.target.value)}
                        placeholder={t(locale, 'admin.common.reasonPlaceholder')}
                      />
                    </label>
                    {retryError ? (
                      <div className="errorBox" role="alert">
                        {retryError}
                      </div>
                    ) : null}
                    <div className="panelActions">
                      <button
                        type="button"
                        className="primaryButton"
                        disabled={submittingId === refund.id || !retryReason.trim()}
                        onClick={() => {
                          void handleConfirmRetry(refund.id);
                        }}
                      >
                        {t(locale, 'admin.refunds.confirmButton')}
                      </button>
                      <button
                        type="button"
                        className="secondaryButton"
                        onClick={() => {
                          setPendingRetryId(null);
                          setRetryReason('');
                          setRetryError(null);
                        }}
                      >
                        {t(locale, 'admin.common.cancelAction')}
                      </button>
                    </div>
                  </section>
                ) : (
                  <div className="panelActions">
                    <button
                      type="button"
                      className="primaryButton"
                      onClick={() => {
                        setPendingRetryId(refund.id);
                        setRetryReason('');
                        setRetryError(null);
                      }}
                    >
                      {t(locale, 'admin.refunds.retryButton')}
                    </button>
                  </div>
                )
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
