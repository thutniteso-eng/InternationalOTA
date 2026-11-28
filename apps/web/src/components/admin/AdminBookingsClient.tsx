'use client';

import { formatLocalDate, t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  adminApiFetch,
  formatAdminMoneyMinor,
  type AdminProductOption,
  type CustomerBookingListResponse,
} from '@/lib/admin-api';
import type { BookingDetailDto } from '@/lib/booking-api';

const BOOKING_STATUS_VALUES = [
  'held',
  'payment_pending',
  'confirmed',
  'cancelled',
  'expired',
] as const;

function labelForProduct(product: AdminProductOption, locale: BuiltinLocale): string {
  const tr =
    product.translations?.[locale] ?? product.translations?.['vi'] ?? product.translations?.['en'];
  return tr?.title ?? product.slug ?? product.id;
}

export function AdminBookingsClient({
  locale,
  fetchFn = fetch,
}: {
  readonly locale: BuiltinLocale;
  readonly fetchFn?: typeof fetch;
}): React.JSX.Element {
  const [statusFilter, setStatusFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [referenceFilter, setReferenceFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');

  const [products, setProducts] = useState<readonly AdminProductOption[]>([]);
  const [items, setItems] = useState<readonly BookingDetailDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildQueryString = useCallback(
    (cursor?: string | null) => {
      const params = new URLSearchParams();
      params.set('limit', '20');
      if (statusFilter) params.set('status', statusFilter);
      if (productFilter) params.set('productId', productFilter);
      if (referenceFilter.trim()) params.set('reference', referenceFilter.trim());
      if (fromFilter) params.set('from', fromFilter);
      if (toFilter) params.set('to', toFilter);
      if (cursor) params.set('cursor', cursor);
      return params.toString();
    },
    [fromFilter, productFilter, referenceFilter, statusFilter, toFilter],
  );

  const loadBookings = useCallback(
    async (cursor?: string | null) => {
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      const res = await adminApiFetch<CustomerBookingListResponse>(
        `/api/admin/bookings?${buildQueryString(cursor)}`,
        {},
        fetchFn,
      );
      if (!res.ok) {
        setError(res.message ?? t(locale, 'admin.common.actionError'));
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      if (cursor) {
        setItems((prev) => [...prev, ...res.data.items]);
      } else {
        setItems(res.data.items);
      }
      setNextCursor(res.data.nextCursor);
      setLoading(false);
      setLoadingMore(false);
    },
    [buildQueryString, fetchFn, locale],
  );

  useEffect(() => {
    let active = true;
    async function init(): Promise<void> {
      const [prodRes] = await Promise.all([
        adminApiFetch<{ items?: readonly AdminProductOption[] }>(
          '/api/admin/products?limit=100',
          {},
          fetchFn,
        ),
        loadBookings(null),
      ]);
      if (active && prodRes.ok && Array.isArray(prodRes.data.items)) {
        setProducts(prodRes.data.items);
      }
    }
    void init();
    return () => {
      active = false;
    };
  }, [fetchFn, loadBookings]);

  return (
    <div className="adminStack">
      <section className="heroIntro">
        <h1 className="pageTitle">{t(locale, 'admin.bookings.title')}</h1>
        <p className="pageSubtitle">{t(locale, 'admin.bookings.subtitle')}</p>
      </section>

      <form
        className="widgetCard adminFilterForm"
        onSubmit={(e) => {
          e.preventDefault();
          void loadBookings(null);
        }}
      >
        <div className="adminFilterGrid">
          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.bookings.filterStatus')}</span>
            <select
              className="adminInput"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">{t(locale, 'admin.bookings.allStatuses')}</option>
              {BOOKING_STATUS_VALUES.map((st) => (
                <option key={st} value={st}>
                  {t(locale, `demo.booking.status.${st}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.bookings.filterProduct')}</span>
            <select
              className="adminInput"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
            >
              <option value="">{t(locale, 'admin.bookings.allProducts')}</option>
              {products.map((prod) => (
                <option key={prod.id} value={prod.id}>
                  {labelForProduct(prod, locale)}
                </option>
              ))}
            </select>
          </label>

          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.bookings.filterReference')}</span>
            <input
              type="text"
              className="adminInput"
              value={referenceFilter}
              onChange={(e) => setReferenceFilter(e.target.value)}
              placeholder={t(locale, 'admin.bookings.referencePlaceholder')}
            />
          </label>

          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.bookings.filterFrom')}</span>
            <input
              type="date"
              className="adminInput"
              value={fromFilter}
              onChange={(e) => setFromFilter(e.target.value)}
            />
          </label>

          <label className="adminFieldLabel">
            <span>{t(locale, 'admin.bookings.filterTo')}</span>
            <input
              type="date"
              className="adminInput"
              value={toFilter}
              onChange={(e) => setToFilter(e.target.value)}
            />
          </label>
        </div>

        <div className="panelActions">
          <button type="submit" className="primaryButton">
            {t(locale, 'admin.common.applyFilters')}
          </button>
          <button
            type="button"
            className="secondaryButton"
            onClick={() => {
              setStatusFilter('');
              setProductFilter('');
              setReferenceFilter('');
              setFromFilter('');
              setToFilter('');
            }}
          >
            {t(locale, 'admin.common.resetFilters')}
          </button>
        </div>
      </form>

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
        <div className="bookingListGrid">
          {items.map((item) => (
            <article key={item.id} className="bookingSummaryCard">
              <div className="bookingCardTop">
                <h2 className="cardTitle">
                  <Link href={`/${locale}/admin/bookings/${encodeURIComponent(item.reference)}`}>
                    {item.reference}
                  </Link>
                </h2>
                <span className="statusChip statusChipPending">
                  {t(locale, `demo.booking.status.${item.status}`)}
                </span>
              </div>
              <p className="resultMeta">
                {t(locale, 'admin.bookings.guestName')}: <strong>{item.contactName}</strong>
              </p>
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
                  {formatAdminMoneyMinor(item.totalAmountMinor, item.currency, locale)}
                </span>
                <Link
                  href={`/${locale}/admin/bookings/${encodeURIComponent(item.reference)}`}
                  className="secondaryButton"
                >
                  {t(locale, 'admin.bookings.viewDetail')}
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
            disabled={loadingMore}
            onClick={() => {
              void loadBookings(nextCursor);
            }}
          >
            {loadingMore ? t(locale, 'admin.common.loading') : t(locale, 'admin.common.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
