'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import { useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import type { PublicCatalogListResponse, PublicCatalogProductSummary } from '@/lib/catalog-api';

export function CatalogLoadMoreButton({
  locale,
  initialCursor,
  q,
  kind,
  limit,
}: {
  readonly locale: BuiltinLocale;
  readonly initialCursor: string | null;
  readonly q: string;
  readonly kind: string;
  readonly limit: number;
}): React.JSX.Element | null {
  const [extraItems, setExtraItems] = useState<readonly PublicCatalogProductSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  if (extraItems.length === 0 && !cursor) {
    return null;
  }

  async function handleLoadMore(): Promise<void> {
    if (!cursor || loading) {
      return;
    }
    setLoading(true);
    setHasError(false);
    try {
      const params = new URLSearchParams();
      params.set('locale', locale);
      params.set('limit', String(limit));
      params.set('cursor', cursor);
      if (q) {
        params.set('q', q);
      }
      if (kind === 'tour' || kind === 'activity') {
        params.set('kind', kind);
      }

      const res = await fetch(`/api/catalog/products?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        setHasError(true);
        return;
      }
      const data = (await res.json()) as PublicCatalogListResponse;
      setExtraItems((prev) => [...prev, ...data.items]);
      setCursor(data.nextCursor);
    } catch {
      setHasError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {extraItems.length > 0 ? (
        <div className="cardGrid" style={{ marginTop: '1rem' }}>
          {extraItems.map((product) => (
            <ProductCard key={product.id} product={product} locale={locale} />
          ))}
        </div>
      ) : null}

      {hasError ? (
        <div className="errorBox" style={{ marginTop: '1rem' }} role="alert">
          {t(locale, 'demo.list.errorTitle')}
        </div>
      ) : null}

      {cursor ? (
        <div className="loadMoreWrap">
          <button
            type="button"
            className="secondaryButton"
            disabled={loading}
            onClick={() => {
              void handleLoadMore();
            }}
          >
            {t(locale, 'demo.list.loadMore')}
          </button>
        </div>
      ) : null}
    </>
  );
}
