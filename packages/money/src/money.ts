import { assertSupportedCurrency, type CurrencyCode } from './currencies.ts';
import { CurrencyMismatchError, EmptyListError } from './errors.ts';

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export function createMoney(amountMinor: bigint, currency: CurrencyCode): Money {
  assertSupportedCurrency(currency);
  return Object.freeze({
    amountMinor,
    currency,
  });
}

export const money = createMoney;

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
  return createMoney(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
  return createMoney(a.amountMinor - b.amountMinor, a.currency);
}

export function multiplyByInt(m: Money, qty: bigint): Money {
  return createMoney(m.amountMinor * qty, m.currency);
}

export function negate(m: Money): Money {
  return createMoney(-m.amountMinor, m.currency);
}

export function isZero(m: Money): boolean {
  return m.amountMinor === 0n;
}

export function isNegative(m: Money): boolean {
  return m.amountMinor < 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
  if (a.amountMinor < b.amountMinor) {
    return -1;
  }
  if (a.amountMinor > b.amountMinor) {
    return 1;
  }
  return 0;
}

export function sum(list: readonly Money[], currency?: CurrencyCode): Money {
  if (list.length === 0) {
    if (!currency) {
      throw new EmptyListError('sum() on an empty list requires an explicit currency');
    }
    assertSupportedCurrency(currency);
    return createMoney(0n, currency);
  }

  const targetCurrency = currency ?? list[0]!.currency;
  assertSupportedCurrency(targetCurrency);

  let total = 0n;
  for (const item of list) {
    if (item.currency !== targetCurrency) {
      throw new CurrencyMismatchError(targetCurrency, item.currency);
    }
    total += item.amountMinor;
  }

  return createMoney(total, targetCurrency);
}
