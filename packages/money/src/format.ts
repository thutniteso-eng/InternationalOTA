import { assertSupportedCurrency, getCurrencyExponent, type CurrencyCode } from './currencies.ts';
import { InvalidMoneyError } from './errors.ts';
import type { Money } from './money.ts';

export function parseMoney(str: string, currency: CurrencyCode): bigint {
  assertSupportedCurrency(currency);

  const trimmed = str.trim();
  if (!trimmed) {
    throw new InvalidMoneyError('Money string cannot be empty');
  }

  // Reject thousands separators, commas, spaces, underscores, scientific notation
  if (/[,\s_eE]/.test(str)) {
    throw new InvalidMoneyError(`Invalid money format: "${str}"`);
  }

  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new InvalidMoneyError(`Invalid money format: "${str}"`);
  }

  const isNegative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');

  const parts = unsigned.split('.');
  const integerPartStr = parts[0] ?? '0';
  const fractionalPartStr = parts[1] ?? '';

  const exponent = getCurrencyExponent(currency);

  if (fractionalPartStr.length > exponent) {
    throw new InvalidMoneyError(
      `Too many decimal places for currency ${currency}: expected at most ${exponent}, got ${fractionalPartStr.length}`,
    );
  }

  const paddedFractional = fractionalPartStr.padEnd(exponent, '0');
  const integerPart = BigInt(integerPartStr);
  const factor = 10n ** BigInt(exponent);
  const fractionalPart = paddedFractional ? BigInt(paddedFractional) : 0n;

  const rawAmountMinor = integerPart * factor + fractionalPart;
  return isNegative ? -rawAmountMinor : rawAmountMinor;
}

export function formatMoneyPlain(m: Money): string {
  assertSupportedCurrency(m.currency);
  const exponent = getCurrencyExponent(m.currency);

  if (exponent === 0) {
    return m.amountMinor.toString();
  }

  const sign = m.amountMinor < 0n ? '-' : '';
  const absAmount = m.amountMinor < 0n ? -m.amountMinor : m.amountMinor;
  const factor = 10n ** BigInt(exponent);

  const integerPart = absAmount / factor;
  const fractionalPart = (absAmount % factor).toString().padStart(exponent, '0');

  return `${sign}${integerPart.toString()}.${fractionalPart}`;
}
