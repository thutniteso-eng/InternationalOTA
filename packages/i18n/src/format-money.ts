import {
  assertSupportedCurrency,
  formatMoneyPlain,
  getCurrencyExponent,
  isSupportedCurrency,
  type Money,
} from '@internationalota/money';

export interface FormattableMoney {
  readonly amountMinor: bigint;
  readonly currency: string;
}

/**
 * ISO 4217 3-decimal currencies present in `reference.currencies` (`enabled_for_sale = false`)
 * so display formatting supports non-sale ISO currencies (such as KWD) without expanding
 * `@internationalota/money`'s sale-enabled `SUPPORTED_CURRENCIES`.
 */
const ISO_EXTRA_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

function formatMinorUnitsToDecimalString(amountMinor: bigint, exponent: number): string {
  if (exponent === 0) {
    return amountMinor.toString();
  }
  const sign = amountMinor < 0n ? '-' : '';
  const absAmount = amountMinor < 0n ? -amountMinor : amountMinor;
  const factor = 10n ** BigInt(exponent);
  const integerPart = absAmount / factor;
  const fractionalPart = (absAmount % factor).toString().padStart(exponent, '0');
  return `${sign}${integerPart.toString()}.${fractionalPart}`;
}

/**
 * Formats a `Money` value (bigint minor units) for display in `locale`.
 *
 * - Uses `Intl.NumberFormat` with `style: 'currency'`.
 * - Forces `minimumFractionDigits` and `maximumFractionDigits` strictly from
 *   `@internationalota/money`'s `getCurrencyExponent(money.currency)` (or ISO 4217
 *   exponent for non-sale display currencies like KWD) — never Intl's own defaults.
 * - Formats via exact decimal string (pure bigint arithmetic) passed to
 *   `Intl.NumberFormat.prototype.format(string)` — NEVER converts amounts through
 *   JavaScript `number`, so values beyond `Number.MAX_SAFE_INTEGER` (e.g. `9007199254740993n`)
 *   format with zero precision loss.
 */
export function formatMoney(money: Money | FormattableMoney, locale: string): string {
  let exponent: number;
  let exactDecimalString: string;

  if (isSupportedCurrency(money.currency)) {
    exponent = getCurrencyExponent(money.currency);
    exactDecimalString = formatMoneyPlain({
      amountMinor: money.amountMinor,
      currency: money.currency,
    });
  } else {
    const extraExponent = ISO_EXTRA_CURRENCY_EXPONENTS[money.currency];
    if (extraExponent === undefined) {
      assertSupportedCurrency(money.currency);
      throw new Error(`Unsupported currency: ${money.currency}`);
    }
    exponent = extraExponent;
    exactDecimalString = formatMinorUnitsToDecimalString(money.amountMinor, exponent);
  }

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
