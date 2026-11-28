'use client';

import { formatLocalDate, t, type BuiltinLocale } from '@internationalota/i18n';
import { addDays } from '@internationalota/time';
import { useCallback, useEffect, useState } from 'react';
import {
  adminApiFetch,
  createAdminIdempotencyKey,
  type AdminDepartureDto,
  type AdminProductOption,
  type DepartureCancellationSummaryDto,
  type DepartureCancelResultDto,
} from '@/lib/admin-api';

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function labelForProduct(product: AdminProductOption, locale: BuiltinLocale): string {
  const tr =
    product.translations?.[locale] ?? product.translations?.['vi'] ?? product.translations?.['en'];
  return tr?.title ?? product.slug ?? product.id;
}

export function canSubmitDepartureConfirm(
  mode: 'close' | 'reopen' | 'cancel',
  reason: string,
  submitting = false,
  loadingSummary = false,
): boolean {
  if (submitting || loadingSummary) {
    return false;
  }
  if (mode === 'cancel') {
    return reason.trim().length > 0;
  }
  return true;
}

export function DepartureConfirmPanelView({
  locale,
  departureId,
  mode,
  loadingSummary,
  cancelSummary,
  actionReason,
  actionError,
  submitting,
  onReasonChange,
  onConfirm,
  onCancel,
}: {
  readonly locale: BuiltinLocale;
  readonly departureId: string;
  readonly mode: 'close' | 'reopen' | 'cancel';
  readonly loadingSummary: boolean;
  readonly cancelSummary: DepartureCancellationSummaryDto | null;
  readonly actionReason: string;
  readonly actionError: string | null;
  readonly submitting: boolean;
  readonly onReasonChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <section
      className="cancelConfirmPanel"
      aria-live="polite"
      data-testid={`dep-confirm-${departureId}`}
    >
      <h2 className="sectionHeading">
        {mode === 'cancel'
          ? t(locale, 'admin.departures.confirmCancelTitle')
          : mode === 'close'
            ? t(locale, 'admin.departures.confirmCloseTitle')
            : t(locale, 'admin.departures.confirmReopenTitle')}
      </h2>

      {mode === 'cancel' ? (
        loadingSummary ? (
          <p className="resultMeta">{t(locale, 'admin.departures.loadingSummary')}</p>
        ) : cancelSummary ? (
          <p className="cancelPreviewText" data-testid="departure-affected-count">
            {t(locale, 'admin.departures.affectedSummary', {
              confirmed: cancelSummary.bookings.confirmed,
              holds: cancelSummary.bookings.held + cancelSummary.bookings.paymentPending,
            })}
          </p>
        ) : null
      ) : null}

      <label className="adminFieldLabel">
        <span>
          {mode === 'cancel'
            ? t(locale, 'admin.common.reasonLabel')
            : t(locale, 'admin.common.optionalReasonLabel')}
        </span>
        <input
          type="text"
          className="adminInput"
          value={actionReason}
          onChange={(e) => onReasonChange(e.target.value)}
          placeholder={t(locale, 'admin.common.reasonPlaceholder')}
        />
      </label>

      {actionError ? (
        <div className="errorBox" role="alert">
          {actionError}
        </div>
      ) : null}

      <div className="panelActions">
        <button
          type="button"
          className={mode === 'cancel' ? 'dangerButton' : 'primaryButton'}
          disabled={!canSubmitDepartureConfirm(mode, actionReason, submitting, loadingSummary)}
          onClick={onConfirm}
        >
          {t(locale, 'admin.departures.confirmSubmit')}
        </button>
        <button type="button" className="secondaryButton" onClick={onCancel}>
          {t(locale, 'admin.common.cancelAction')}
        </button>
      </div>
    </section>
  );
}

export function AdminDeparturesClient({
  locale,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const [products, setProducts] = useState<readonly AdminProductOption[]>([]);
  const [productId, setProductId] = useState('');
  const [fromDate, setFromDate] = useState(() => todayUtcDate());
  const [toDate, setToDate] = useState(() =>
    addDays(todayUtcDate() as `${number}-${number}-${number}`, 30),
  );

  const [departures, setDepartures] = useState<readonly AdminDepartureDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [confirmState, setConfirmState] = useState<{
    readonly departureId: string;
    readonly mode: 'close' | 'reopen' | 'cancel';
  } | null>(null);
  const [cancelSummary, setCancelSummary] = useState<DepartureCancellationSummaryDto | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [actionReason, setActionReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadDepartures = useCallback(
    async (selectedProductId: string, from: string, to: string) => {
      if (!selectedProductId) {
        setDepartures([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const res = await adminApiFetch<{ items: readonly AdminDepartureDto[] }>(
        `/api/admin/inventory/products/${encodeURIComponent(selectedProductId)}/departures?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {},
        fetchFn,
      );
      if (!res.ok) {
        setError(res.message ?? t(locale, 'admin.common.actionError'));
        setLoading(false);
        return;
      }
      setDepartures(res.data.items);
      setLoading(false);
    },
    [fetchFn, locale],
  );

  useEffect(() => {
    let active = true;
    async function init(): Promise<void> {
      const prodRes = await adminApiFetch<{ readonly items?: readonly AdminProductOption[] }>(
        '/api/admin/products?limit=100',
        {},
        fetchFn,
      );
      if (!active) {
        return;
      }
      const rawItems = prodRes.ok ? prodRes.data.items : undefined;
      const list: readonly AdminProductOption[] = Array.isArray(rawItems) ? rawItems : [];
      setProducts(list);
      const firstId: string = list[0]?.id ?? '';
      setProductId(firstId);
      await loadDepartures(firstId, fromDate, toDate);
    }
    void init();
    return () => {
      active = false;
    };
  }, [fetchFn, fromDate, loadDepartures, toDate]);

  async function openConfirmPanel(
    departureId: string,
    mode: 'close' | 'reopen' | 'cancel',
  ): Promise<void> {
    setConfirmState({ departureId, mode });
    setActionReason('');
    setActionError(null);
    setCancelSummary(null);

    if (mode === 'cancel') {
      setLoadingSummary(true);
      const res = await adminApiFetch<DepartureCancellationSummaryDto>(
        `/api/admin/departures/${encodeURIComponent(departureId)}/cancellation-summary`,
        {},
        fetchFn,
      );
      setLoadingSummary(false);
      if (res.ok) {
        setCancelSummary(res.data);
      }
    }
  }

  async function handleConfirmSubmit(): Promise<void> {
    if (!confirmState) {
      return;
    }
    const trimmed = actionReason.trim();
    if (confirmState.mode === 'cancel' && !trimmed) {
      setActionError(t(locale, 'admin.common.reasonRequiredError'));
      return;
    }

    setSubmitting(true);
    setActionError(null);

    const endpoint =
      confirmState.mode === 'cancel'
        ? `/api/admin/departures/${encodeURIComponent(confirmState.departureId)}/cancel`
        : `/api/admin/inventory/departures/${encodeURIComponent(confirmState.departureId)}/${confirmState.mode}`;

    const res = await adminApiFetch<DepartureCancelResultDto | AdminDepartureDto>(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createAdminIdempotencyKey(`dep-${confirmState.mode}`),
        },
        body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
      },
      fetchFn,
    );
    setSubmitting(false);

    if (!res.ok) {
      setActionError(res.message ?? t(locale, 'admin.common.actionError'));
      return;
    }

    if (confirmState.mode === 'cancel' && 'activeHoldsCancelledCount' in res.data) {
      setSuccessMsg(
        t(locale, 'admin.departures.cancelSuccess', {
          holds: res.data.activeHoldsCancelledCount,
          confirmed: res.data.confirmedJobsEnqueuedCount,
        }),
      );
    } else {
      setSuccessMsg(null);
    }
    setConfirmState(null);
    setCancelSummary(null);
    await loadDepartures(productId, fromDate, toDate);
  }

  return (
    <div className="adminStack">
      <section className="heroIntro">
        <h1 className="pageTitle">{t(locale, 'admin.departures.title')}</h1>
        <p className="pageSubtitle">{t(locale, 'admin.departures.subtitle')}</p>
      </section>

      <form
        className="widgetCard adminFilterForm"
        onSubmit={(e) => {
          e.preventDefault();
          void loadDepartures(productId, fromDate, toDate);
        }}
      >
        <div className="adminFilterGrid">
          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.departures.productLabel')}</span>
            <select
              className="adminInput"
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                void loadDepartures(e.target.value, fromDate, toDate);
              }}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {labelForProduct(p, locale)}
                </option>
              ))}
            </select>
          </label>

          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.departures.fromLabel')}</span>
            <input
              type="date"
              className="adminInput"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </label>

          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.departures.toLabel')}</span>
            <input
              type="date"
              className="adminInput"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </label>
        </div>

        <div className="panelActions">
          <button type="submit" className="primaryButton">
            {t(locale, 'admin.common.applyFilters')}
          </button>
        </div>
      </form>

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
      ) : departures.length === 0 ? (
        <div className="emptyState">{t(locale, 'admin.common.empty')}</div>
      ) : (
        <div className="adminStack">
          {departures.map((dep) => (
            <article key={dep.id} className="widgetCard">
              <div className="bookingCardTop">
                <strong>
                  {formatLocalDate(dep.localDate, locale)} · {dep.localTime.slice(0, 5)}
                </strong>
                <span className="statusChip statusChipPending">
                  {t(locale, `admin.departures.status.${dep.status}`)}
                </span>
              </div>
              <p className="resultMeta">
                {t(locale, 'admin.departures.seatsSummary', {
                  allocated: dep.allocated,
                  capacity: dep.capacity,
                  remaining: dep.remaining,
                })}
              </p>

              {confirmState?.departureId === dep.id ? (
                <DepartureConfirmPanelView
                  locale={locale}
                  departureId={dep.id}
                  mode={confirmState.mode}
                  loadingSummary={loadingSummary}
                  cancelSummary={cancelSummary}
                  actionReason={actionReason}
                  actionError={actionError}
                  submitting={submitting}
                  onReasonChange={setActionReason}
                  onConfirm={() => {
                    void handleConfirmSubmit();
                  }}
                  onCancel={() => {
                    setConfirmState(null);
                    setActionError(null);
                    setCancelSummary(null);
                  }}
                />
              ) : dep.status !== 'cancelled' ? (
                <div className="panelActions">
                  {dep.status === 'open' ? (
                    <button
                      type="button"
                      className="secondaryButton"
                      onClick={() => {
                        void openConfirmPanel(dep.id, 'close');
                      }}
                    >
                      {t(locale, 'admin.departures.closeButton')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondaryButton"
                      onClick={() => {
                        void openConfirmPanel(dep.id, 'reopen');
                      }}
                    >
                      {t(locale, 'admin.departures.reopenButton')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="dangerButton"
                    onClick={() => {
                      void openConfirmPanel(dep.id, 'cancel');
                    }}
                  >
                    {t(locale, 'admin.departures.cancelButton')}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
