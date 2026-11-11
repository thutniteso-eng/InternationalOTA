import { assertSupportedCurrency, type CurrencyCode } from './currencies.ts';
import { InvalidMoneyError } from './errors.ts';
import { createMoney, type Money } from './money.ts';

export interface MoneyJson {
  readonly amountMinor: string;
  readonly currency: CurrencyCode;
}

export function toJSON(m: Money): MoneyJson {
  return {
    amountMinor: m.amountMinor.toString(),
    currency: m.currency,
  };
}

export function fromJSON(data: unknown): Money {
  if (typeof data !== 'object' || data === null) {
    throw new InvalidMoneyError('Invalid Money JSON: expected an object');
  }

  const record = data as Record<string, unknown>;

  if (typeof record['currency'] !== 'string') {
    throw new InvalidMoneyError('Invalid Money JSON: currency must be a string');
  }
  assertSupportedCurrency(record['currency']);

  if (typeof record['amountMinor'] !== 'string' || !/^[+-]?\d+$/.test(record['amountMinor'])) {
    throw new InvalidMoneyError(
      `Invalid Money JSON: amountMinor must be a valid integer string, got "${String(record['amountMinor'])}"`,
    );
  }

  return createMoney(BigInt(record['amountMinor']), record['currency']);
}
