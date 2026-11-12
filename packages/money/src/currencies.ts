import { UnsupportedCurrencyError } from './errors.ts';

export const SUPPORTED_CURRENCIES = {
  VND: { exponent: 0 },
  USD: { exponent: 2 },
  EUR: { exponent: 2 },
  GBP: { exponent: 2 },
  AUD: { exponent: 2 },
  SGD: { exponent: 2 },
  THB: { exponent: 2 },
  CNY: { exponent: 2 },
  KRW: { exponent: 0 },
  JPY: { exponent: 0 },
} as const;

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES;

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, code);
}

export function assertSupportedCurrency(code: string): asserts code is CurrencyCode {
  if (!isSupportedCurrency(code)) {
    throw new UnsupportedCurrencyError(code);
  }
}

export function getCurrencyExponent(currency: string): number {
  assertSupportedCurrency(currency);
  return SUPPORTED_CURRENCIES[currency].exponent;
}
