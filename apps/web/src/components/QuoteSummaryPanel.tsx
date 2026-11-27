import { formatMoney, t, type BuiltinLocale } from '@internationalota/i18n';
import { assertSupportedCurrency, createMoney } from '@internationalota/money';
import type { PublicQuoteResponse } from '@/lib/catalog-api';

function formatExactMinor(minorStr: string, currencyRaw: string, locale: BuiltinLocale): string {
  assertSupportedCurrency(currencyRaw);
  return formatMoney(createMoney(BigInt(minorStr), currencyRaw), locale);
}

export function QuoteSummaryPanel({
  locale,
  quote,
  errorMessage,
  isLoading,
}: {
  readonly locale: BuiltinLocale;
  readonly quote: PublicQuoteResponse | null;
  readonly errorMessage: string | null;
  readonly isLoading: boolean;
}): React.JSX.Element {
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
                  paxLabel: t(locale, `demo.detail.pax.${line.paxType}`),
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

      <button type="button" disabled className="primaryButton bookButton">
        {t(locale, 'demo.detail.bookButtonComingSoon')}
      </button>
    </div>
  );
}
