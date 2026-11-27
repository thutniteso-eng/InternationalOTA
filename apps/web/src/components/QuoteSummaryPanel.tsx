import { t, type BuiltinLocale } from '@internationalota/i18n';
import {
  formatExactMinor,
  formatPaxStepperLabel,
  type PublicQuoteWithBands,
} from '@/lib/booking-api';

export function QuoteSummaryPanel({
  locale,
  quote,
  errorMessage,
  isLoading,
  canBook = false,
  bookLoading = false,
  onBookClick,
}: {
  readonly locale: BuiltinLocale;
  readonly quote: PublicQuoteWithBands | null;
  readonly errorMessage: string | null;
  readonly isLoading: boolean;
  readonly canBook?: boolean;
  readonly bookLoading?: boolean;
  readonly onBookClick?: () => void;
}): React.JSX.Element {
  const isButtonEnabled = Boolean(canBook && quote && !isLoading && !bookLoading && onBookClick);

  return (
    <div aria-live="polite">
      {isLoading ? <p className="resultMeta">{t(locale, 'demo.detail.quoteLoading')}</p> : null}

      {errorMessage ? (
        <div className="errorBox" role="alert">
          {errorMessage}
        </div>
      ) : null}

      {quote ? (
        <div className="quoteBreakdown">
          {quote.lines.map((line) => (
            <div key={line.paxType} className="quoteLineRow">
              <span>
                {t(locale, 'demo.detail.quoteLine', {
                  paxLabel: formatPaxStepperLabel(line.paxType, locale, quote.ageBands),
                  quantity: line.quantity,
                })}
              </span>
              <span>{formatExactMinor(line.lineAmountMinor, quote.currency, locale)}</span>
            </div>
          ))}
          <div className="quoteTotalRow">
            <span>{t(locale, 'demo.detail.quoteTotal')}</span>
            <span data-testid="quote-total">
              {formatExactMinor(quote.totalAmountMinor, quote.currency, locale)}
            </span>
          </div>
          <p className="quoteMetaNote">
            {t(locale, 'demo.detail.quoteSeatsRequired', { seats: quote.seats })}
          </p>
          <p className="quoteMetaNote">
            {t(locale, 'demo.detail.quoteVersionMeta', {
              priceVersion: quote.priceListVersion,
              policyVersion: quote.cancellationPolicyVersion,
            })}
          </p>
        </div>
      ) : null}

      <button
        type="button"
        disabled={!isButtonEnabled}
        onClick={onBookClick}
        className="primaryButton bookButton"
      >
        {bookLoading ? t(locale, 'demo.auth.submitting') : t(locale, 'demo.detail.bookNowButton')}
      </button>
    </div>
  );
}
