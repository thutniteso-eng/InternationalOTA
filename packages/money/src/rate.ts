import type { Decimal } from './decimal.ts';
import { createMoney, type Money } from './money.ts';
import { roundFraction, type RoundingMode } from './rounding.ts';

/**
 * Applies a decimal rate to money and rounds at the currency's minor unit.
 *
 * Note: unlike cross-currency conversion, applyRate accepts negative and zero rates
 * (e.g. for calculating discounts, deductions, or zero markups).
 */
export function applyRate(m: Money, rate: Decimal, rounding: RoundingMode): Money {
  const numerator = m.amountMinor * rate.numerator;
  const denominator = rate.denominator;
  const roundedMinor = roundFraction(numerator, denominator, rounding);
  return createMoney(roundedMinor, m.currency);
}
