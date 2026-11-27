import { t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import {
  formatDuration,
  type ProductKind,
  type PublicCatalogProductSummary,
} from '@/lib/catalog-api';

function coverClassForKind(kind: ProductKind): string {
  if (kind === 'activity') {
    return 'kindCover kindCoverActivity';
  }
  if (kind === 'transfer') {
    return 'kindCover kindCoverTransfer';
  }
  return 'kindCover kindCoverTour';
}

export function ProductCard({
  product,
  locale,
}: {
  readonly product: PublicCatalogProductSummary;
  readonly locale: BuiltinLocale;
}): React.JSX.Element {
  const kindLabel = t(locale, `demo.list.kind.${product.kind}`);
  const durationLabel = formatDuration(product.durationMinutes, locale);
  const priceLabel = product.fromPrice
    ? t(locale, 'demo.list.fromPrice', { price: product.fromPrice.formatted })
    : t(locale, 'demo.list.priceOnRequest');
  const detailHref = `/${locale}/tours/${product.slug}`;

  return (
    <article className="tourCard">
      <div className={coverClassForKind(product.kind)} aria-hidden="true">
        <span className="kindBadge">{kindLabel}</span>
      </div>
      <div className="cardBody">
        <h2 className="cardTitle">
          <Link href={detailHref}>{product.title}</Link>
        </h2>
        <p className="cardSummary">{product.summary}</p>
        <div className="cardMetaRow">
          <span>{product.region}</span>
          {durationLabel ? <span>{durationLabel}</span> : null}
        </div>
        <div className="cardFooter">
          <span className="cardPrice">{priceLabel}</span>
          <Link href={detailHref} className="secondaryButton">
            {t(locale, 'demo.list.viewDetails')}
          </Link>
        </div>
      </div>
    </article>
  );
}
