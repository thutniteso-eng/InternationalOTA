import {
  assertSupportedCurrency,
  formatMoneyPlain,
  getCurrencyExponent,
  type Money,
} from '@internationalota/money';

/**
 * Formats a `Money` value (bigint minor units) for display in `locale`.
 *
 * - Accepts only currencies supported by `@internationalota/money`.
 * - Uses `Intl.NumberFormat` with `style: 'currency'`.
 * - Forces `minimumFractionDigits` and `maximumFractionDigits` strictly from
 *   `@internationalota/money`'s `getCurrencyExponent(money.currency)` (never Intl's own defaults).
 * - Formats via exact decimal string from `formatMoneyPlain(money)` (pure bigint arithmetic)
 *   passed to `Intl.NumberFormat.prototype.format(string)` — NEVER converts amounts through
 *   JavaScript `number`, so values beyond `Number.MAX_SAFE_INTEGER` (e.g. `9007199254740993n`)
 *   format with zero precision loss.
 */
export function formatMoney(money: Money, locale: string): string {
  assertSupportedCurrency(money.currency);
  const exponent = getCurrencyExponent(money.currency);
  const exactDecimalString = formatMoneyPlain(money);

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  });

  // ECMAScript Intl.NumberFormat v3 (ES2023+ / Node 20+) accepts decimal numeric strings
  // with arbitrary precision without routing through IEEE-754 number.
  const decimalFormatter = formatter as unknown as { format(value: string): string };
  return decimalFormatter.format(exactDecimalString);
}
