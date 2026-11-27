'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import { formatExactMinor } from '@/lib/booking-api';
import type { PublicQuoteResponse } from '@/lib/catalog-api';

export function PriceChangedPanel({
  locale,
  previousQuote,
  updatedQuote,
  accepting,
  onAcceptNewPrice,
  onBack,
}: {
  readonly locale: BuiltinLocale;
  readonly previousQuote: PublicQuoteResponse;
  readonly updatedQuote: PublicQuoteResponse;
  readonly accepting?: boolean;
  readonly onAcceptNewPrice: () => void;
  readonly onBack?: () => void;
}): React.JSX.Element {
  const oldTotal = formatExactMinor(previousQuote.totalAmountMinor, previousQuote.currency, locale);
  const newTotal = formatExactMinor(updatedQuote.totalAmountMinor, updatedQuote.currency, locale);

  return (
    <section
      className="priceChangedPanel"
      role="alertdialog"
      aria-labelledby="price-changed-heading"
    >
      <h2 id="price-changed-heading" className="sectionHeading">
        {t(locale, 'demo.book.priceChangedTitle')}
      </h2>
      <p className="priceChangedBody">
        {t(locale, 'demo.book.priceChangedBody', { oldTotal, newTotal })}
      </p>

      <dl className="priceCompareGrid">
        <div>
          <dt>{t(locale, 'demo.book.oldTotalLabel')}</dt>
          <dd className="priceOldValue" data-testid="old-quote-total">
            {oldTotal}
          </dd>
        </div>
        <div>
          <dt>{t(locale, 'demo.book.newTotalLabel')}</dt>
          <dd className="priceNewValue" data-testid="new-quote-total">
            {newTotal}
          </dd>
        </div>
      </dl>

      <div className="panelActions">
        <button
          type="button"
          className="primaryButton"
          disabled={accepting}
          onClick={onAcceptNewPrice}
        >
          {accepting
            ? t(locale, 'demo.book.submittingHold')
            : t(locale, 'demo.book.acceptNewPrice')}
        </button>
        {onBack ? (
          <button type="button" className="secondaryButton" onClick={onBack}>
            {t(locale, 'demo.book.backToDateStrip')}
          </button>
        ) : null}
      </div>
    </section>
  );
}
