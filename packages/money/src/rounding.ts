export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

export const RoundingMode = {
  HALF_UP: 'HALF_UP',
  HALF_EVEN: 'HALF_EVEN',
  DOWN: 'DOWN',
  UP: 'UP',
} as const;

export function roundFraction(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new Error('Division by zero in roundFraction');
  }

  let num = numerator;
  let den = denominator;
  if (den < 0n) {
    num = -num;
    den = -den;
  }

  const sign = num < 0n ? -1n : 1n;
  const absNum = num < 0n ? -num : num;

  const quotient = absNum / den;
  const remainder = absNum % den;

  if (remainder === 0n) {
    return sign * quotient;
  }

  switch (mode) {
    case 'DOWN':
      return sign * quotient;

    case 'UP':
      return sign * (quotient + 1n);

    case 'HALF_UP': {
      const doubleRemainder = remainder * 2n;
      if (doubleRemainder >= den) {
        return sign * (quotient + 1n);
      }
      return sign * quotient;
    }

    case 'HALF_EVEN': {
      const doubleRemainder = remainder * 2n;
      if (doubleRemainder > den) {
        return sign * (quotient + 1n);
      }
      if (doubleRemainder < den) {
        return sign * quotient;
      }
      const isQuotientEven = quotient % 2n === 0n;
      return isQuotientEven ? sign * quotient : sign * (quotient + 1n);
    }

    default: {
      const exhaustiveCheck: never = mode;
      throw new Error(`Unsupported rounding mode: ${String(exhaustiveCheck)}`);
    }
  }
}
