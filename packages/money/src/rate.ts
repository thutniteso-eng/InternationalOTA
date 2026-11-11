import type { Decimal } from './decimal.ts';
import { createMoney, type Money } from './money.ts';
import { roundFraction, type RoundingMode } from './rounding.ts';

export function applyRate(m: Money, rate: Decimal, rounding: RoundingMode): Money {
  const numerator = m.amountMinor * rate.numerator;
  const denominator = rate.denominator;
  const roundedMinor = roundFraction(numerator, denominator, rounding);
  return createMoney(roundedMinor, m.currency);
}
