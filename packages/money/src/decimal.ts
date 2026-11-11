import { InvalidRateError } from './errors.ts';

export interface Decimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly text: string;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y > 0n) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x;
}

export function decimal(str: string): Decimal {
  const trimmed = str.trim();
  if (!trimmed) {
    throw new InvalidRateError('Rate string cannot be empty');
  }

  // Reject scientific notation, commas, NaN, Infinity, or multiple dots
  if (/[eE,]/.test(trimmed) || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    throw new InvalidRateError(`Invalid decimal format: "${str}"`);
  }

  const isNegative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');

  const parts = unsigned.split('.');
  const integerPartStr = parts[0] ?? '0';
  const fractionalPartStr = parts[1] ?? '';

  if (integerPartStr === '' && fractionalPartStr === '') {
    throw new InvalidRateError(`Invalid decimal format: "${str}"`);
  }

  const numDecimals = fractionalPartStr.length;
  const denominator = 10n ** BigInt(numDecimals);
  const integerPart = integerPartStr ? BigInt(integerPartStr) : 0n;
  const fractionalPart = fractionalPartStr ? BigInt(fractionalPartStr) : 0n;

  const rawNumerator = integerPart * denominator + fractionalPart;
  const signedNumerator = isNegative ? -rawNumerator : rawNumerator;

  const divisor = gcd(signedNumerator, denominator);
  const simplifiedNumerator = divisor > 0n ? signedNumerator / divisor : signedNumerator;
  const simplifiedDenominator = divisor > 0n ? denominator / divisor : denominator;

  return Object.freeze({
    numerator: simplifiedNumerator,
    denominator: simplifiedDenominator,
    text: trimmed,
  });
}
