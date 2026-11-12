import { assertSupportedCurrency, getCurrencyExponent, type CurrencyCode } from './currencies.ts';
import type { Decimal } from './decimal.ts';
import { createMoney, type Money } from './money.ts';
import { roundFraction, type RoundingMode } from './rounding.ts';

export interface FxSnapshot {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rate: string;
  readonly source: string;
  readonly asOf: string;
}

export interface ConvertOptions {
  readonly source?: string;
  readonly asOf?: string;
}

export function convert(
  m: Money,
  rate: Decimal,
  to: CurrencyCode,
  rounding: RoundingMode,
  options?: ConvertOptions,
): { converted: Money; snapshot: FxSnapshot } {
  assertSupportedCurrency(m.currency);
  assertSupportedCurrency(to);

  const asOf = options?.asOf ?? new Date().toISOString();

  if (m.currency === to) {
    const snapshot: FxSnapshot = {
      base: m.currency,
      quote: to,
      rate: '1',
      source: options?.source ?? 'identity',
      asOf,
    };
    return { converted: m, snapshot };
  }

  const baseExp = getCurrencyExponent(m.currency);
  const quoteExp = getCurrencyExponent(to);

  const baseFactor = 10n ** BigInt(baseExp);
  const quoteFactor = 10n ** BigInt(quoteExp);

  const numerator = m.amountMinor * rate.numerator * quoteFactor;
  const denominator = rate.denominator * baseFactor;

  const convertedAmount = roundFraction(numerator, denominator, rounding);

  const snapshot: FxSnapshot = {
    base: m.currency,
    quote: to,
    rate: rate.text,
    source: options?.source ?? 'manual',
    asOf,
  };

  return {
    converted: createMoney(convertedAmount, to),
    snapshot,
  };
}
