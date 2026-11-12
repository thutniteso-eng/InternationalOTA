import { assertSupportedCurrency, getCurrencyExponent, type CurrencyCode } from './currencies.ts';
import type { Decimal } from './decimal.ts';
import { InvalidRateError } from './errors.ts';
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

const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function convert(
  m: Money,
  rate: Decimal,
  to: CurrencyCode,
  rounding: RoundingMode,
  options?: ConvertOptions,
): { converted: Money; snapshot: FxSnapshot } {
  assertSupportedCurrency(m.currency);
  assertSupportedCurrency(to);

  if (m.currency === to) {
    const asOf = options?.asOf ?? new Date().toISOString();
    const snapshot: FxSnapshot = {
      base: m.currency,
      quote: to,
      rate: '1',
      source: options?.source ?? 'identity',
      asOf,
    };
    return { converted: m, snapshot };
  }

  // E1: Cross-currency conversion requires a strictly positive rate
  if (rate.numerator <= 0n) {
    throw new InvalidRateError(
      `Cross-currency conversion requires a rate greater than 0, got ${rate.text}`,
    );
  }

  // E2: Cross-currency conversion requires explicit source and a valid ISO-8601 UTC asOf timestamp
  if (!options || typeof options.source !== 'string' || !options.source.trim()) {
    throw new InvalidRateError(
      'Cross-currency conversion requires a non-empty "source" in options',
    );
  }

  if (
    typeof options.asOf !== 'string' ||
    !options.asOf.trim() ||
    !ISO_UTC_REGEX.test(options.asOf) ||
    Number.isNaN(Date.parse(options.asOf))
  ) {
    throw new InvalidRateError(
      'Cross-currency conversion requires a valid ISO-8601 UTC "asOf" instant (e.g. 2026-11-12T00:00:00Z)',
    );
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
    source: options.source,
    asOf: options.asOf,
  };

  return {
    converted: createMoney(convertedAmount, to),
    snapshot,
  };
}
