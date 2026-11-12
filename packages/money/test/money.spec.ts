import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  applyRate,
  compare,
  convert,
  createMoney,
  CurrencyMismatchError,
  decimal,
  EmptyListError,
  formatMoneyPlain,
  fromJSON,
  getCurrencyExponent,
  InvalidMoneyError,
  InvalidRateError,
  isNegative,
  isZero,
  money,
  multiplyByInt,
  negate,
  parseMoney,
  RoundingMode,
  subtract,
  sum,
  toJSON,
  UnsupportedCurrencyError,
} from '../src/index.ts';

describe('packages/money - Unit Tests', () => {
  describe('currencies and exponents', () => {
    it('returns correct exponents for supported currencies', () => {
      expect(getCurrencyExponent('VND')).toBe(0);
      expect(getCurrencyExponent('USD')).toBe(2);
      expect(getCurrencyExponent('EUR')).toBe(2);
      expect(getCurrencyExponent('GBP')).toBe(2);
      expect(getCurrencyExponent('AUD')).toBe(2);
      expect(getCurrencyExponent('SGD')).toBe(2);
      expect(getCurrencyExponent('THB')).toBe(2);
      expect(getCurrencyExponent('CNY')).toBe(2);
      expect(getCurrencyExponent('KRW')).toBe(0);
      expect(getCurrencyExponent('JPY')).toBe(0);
    });

    it('throws UnsupportedCurrencyError for unknown currencies', () => {
      expect(() => getCurrencyExponent('XYZ')).toThrow(UnsupportedCurrencyError);
      expect(() => createMoney(100n, 'INVALID' as unknown as 'USD')).toThrow(
        UnsupportedCurrencyError,
      );
    });
  });

  describe('arithmetic operations', () => {
    it('creates money and checks immutability', () => {
      const m = money(100n, 'USD');
      expect(m.amountMinor).toBe(100n);
      expect(m.currency).toBe('USD');
      expect(Object.isFrozen(m)).toBe(true);
    });

    it('adds money in the same currency', () => {
      const a = money(100n, 'USD');
      const b = money(250n, 'USD');
      const result = add(a, b);
      expect(result.amountMinor).toBe(350n);
      expect(result.currency).toBe('USD');
    });

    it('throws CurrencyMismatchError on add with different currencies', () => {
      const a = money(100n, 'USD');
      const b = money(100n, 'EUR');
      expect(() => add(a, b)).toThrow(CurrencyMismatchError);
    });

    it('subtracts money in the same currency', () => {
      const a = money(250n, 'USD');
      const b = money(100n, 'USD');
      const result = subtract(a, b);
      expect(result.amountMinor).toBe(150n);
      expect(result.currency).toBe('USD');
    });

    it('throws CurrencyMismatchError on subtract with different currencies', () => {
      const a = money(250n, 'USD');
      const b = money(100n, 'EUR');
      expect(() => subtract(a, b)).toThrow(CurrencyMismatchError);
    });

    it('multiplies by an integer', () => {
      const m = money(150n, 'USD');
      expect(multiplyByInt(m, 3n).amountMinor).toBe(450n);
      expect(multiplyByInt(m, -2n).amountMinor).toBe(-300n);
      expect(multiplyByInt(m, 0n).amountMinor).toBe(0n);
    });

    it('negates money', () => {
      expect(negate(money(150n, 'USD')).amountMinor).toBe(-150n);
      expect(negate(money(-150n, 'USD')).amountMinor).toBe(150n);
      expect(negate(money(0n, 'USD')).amountMinor).toBe(0n);
    });

    it('checks isZero and isNegative', () => {
      expect(isZero(money(0n, 'USD'))).toBe(true);
      expect(isZero(money(1n, 'USD'))).toBe(false);
      expect(isNegative(money(-1n, 'USD'))).toBe(true);
      expect(isNegative(money(0n, 'USD'))).toBe(false);
      expect(isNegative(money(1n, 'USD'))).toBe(false);
    });

    it('compares money in same currency', () => {
      const a = money(100n, 'USD');
      const b = money(200n, 'USD');
      const c = money(100n, 'USD');

      expect(compare(a, b)).toBe(-1);
      expect(compare(b, a)).toBe(1);
      expect(compare(a, c)).toBe(0);
    });

    it('throws CurrencyMismatchError when comparing different currencies', () => {
      expect(() => compare(money(100n, 'USD'), money(100n, 'EUR'))).toThrow(CurrencyMismatchError);
    });

    it('sums money with explicit or inferred currency', () => {
      const list = [money(100n, 'USD'), money(200n, 'USD'), money(350n, 'USD')];
      expect(sum(list).amountMinor).toBe(650n);
      expect(sum(list, 'USD').amountMinor).toBe(650n);
    });

    it('throws CurrencyMismatchError when summing mismatched currencies', () => {
      const list = [money(100n, 'USD'), money(200n, 'EUR')];
      expect(() => sum(list)).toThrow(CurrencyMismatchError);
    });

    it('throws EmptyListError when summing empty list without explicit currency', () => {
      expect(() => sum([])).toThrow(EmptyListError);
    });

    it('returns zero money when summing empty list with explicit currency', () => {
      const s = sum([], 'USD');
      expect(s.amountMinor).toBe(0n);
      expect(s.currency).toBe('USD');
    });
  });

  describe('allocate', () => {
    it('splits VND 100,000 3 ways → 33,334 / 33,333 / 33,333', () => {
      const vnd = money(100_000n, 'VND');
      const parts = allocate(vnd, [1n, 1n, 1n]);

      expect(parts).toHaveLength(3);
      expect(parts[0]?.amountMinor).toBe(33_334n);
      expect(parts[1]?.amountMinor).toBe(33_333n);
      expect(parts[2]?.amountMinor).toBe(33_333n);
      expect(parts.reduce((acc, p) => acc + p.amountMinor, 0n)).toBe(100_000n);
    });

    it('splits with uneven ratios and largest remainder distribution', () => {
      const m = money(100n, 'USD');
      const parts = allocate(m, [1n, 2n]);
      // 100 * 1 / 3 = 33 rem 1
      // 100 * 2 / 3 = 66 rem 2
      // remainder 2 > 1, so index 1 gets the leftover 1 unit
      expect(parts[0]?.amountMinor).toBe(33n);
      expect(parts[1]?.amountMinor).toBe(67n);
      expect(parts[0]!.amountMinor + parts[1]!.amountMinor).toBe(100n);
    });

    it('handles negative amounts correctly', () => {
      const m = money(-100_000n, 'VND');
      const parts = allocate(m, [1n, 1n, 1n]);
      expect(parts[0]?.amountMinor).toBe(-33_334n);
      expect(parts[1]?.amountMinor).toBe(-33_333n);
      expect(parts[2]?.amountMinor).toBe(-33_333n);
      expect(parts.reduce((acc, p) => acc + p.amountMinor, 0n)).toBe(-100_000n);
    });

    it('rejects empty or zero ratios', () => {
      const m = money(100n, 'USD');
      expect(() => allocate(m, [])).toThrow(InvalidMoneyError);
      expect(() => allocate(m, [0n, 0n])).toThrow(InvalidMoneyError);
      expect(() => allocate(m, [-1n, 2n])).toThrow(InvalidMoneyError);
    });
  });

  describe('Decimal parser', () => {
    it('parses valid decimals without floats', () => {
      const d1 = decimal('0.125');
      expect(d1.numerator).toBe(1n);
      expect(d1.denominator).toBe(8n);
      expect(d1.text).toBe('0.125');

      const d2 = decimal('10');
      expect(d2.numerator).toBe(10n);
      expect(d2.denominator).toBe(1n);

      const d3 = decimal('-0.5');
      expect(d3.numerator).toBe(-1n);
      expect(d3.denominator).toBe(2n);
    });

    it('rejects invalid decimal strings', () => {
      expect(() => decimal('')).toThrow(InvalidRateError);
      expect(() => decimal('1e5')).toThrow(InvalidRateError);
      expect(() => decimal('1,000')).toThrow(InvalidRateError);
      expect(() => decimal('abc')).toThrow(InvalidRateError);
      expect(() => decimal('1.2.3')).toThrow(InvalidRateError);
    });
  });

  describe('applyRate with 4 RoundingModes', () => {
    // 10% commission on USD 0.05 (5 cents)
    // 5 * 0.10 = 0.5 cents
    it('computes 10% commission of USD 0.05 under each rounding mode', () => {
      const m = money(5n, 'USD');
      const tenPercent = decimal('0.10');

      const down = applyRate(m, tenPercent, RoundingMode.DOWN);
      const up = applyRate(m, tenPercent, RoundingMode.UP);
      const halfUp = applyRate(m, tenPercent, RoundingMode.HALF_UP);
      const halfEven = applyRate(m, tenPercent, RoundingMode.HALF_EVEN);

      expect(down.amountMinor).toBe(0n);
      expect(up.amountMinor).toBe(1n);
      expect(halfUp.amountMinor).toBe(1n);
      expect(halfEven.amountMinor).toBe(0n);
    });

    it('verifies HALF_EVEN rounds to nearest even on equidistant values', () => {
      // 1.5 cents -> rounds to 2
      const m15 = money(15n, 'USD');
      const tenPercent = decimal('0.10');
      expect(applyRate(m15, tenPercent, RoundingMode.HALF_EVEN).amountMinor).toBe(2n);

      // 2.5 cents -> rounds to 2
      const m25 = money(25n, 'USD');
      expect(applyRate(m25, tenPercent, RoundingMode.HALF_EVEN).amountMinor).toBe(2n);

      // 3.5 cents -> rounds to 4
      const m35 = money(35n, 'USD');
      expect(applyRate(m35, tenPercent, RoundingMode.HALF_EVEN).amountMinor).toBe(4n);
    });

    it('allows zero and negative rates in applyRate (e.g. for discounts/deductions)', () => {
      const m = money(1000n, 'USD');
      const zeroRate = decimal('0');
      const discountRate = decimal('-0.20');

      expect(applyRate(m, zeroRate, RoundingMode.HALF_UP).amountMinor).toBe(0n);
      expect(applyRate(m, discountRate, RoundingMode.HALF_UP).amountMinor).toBe(-200n);
    });
  });

  describe('parseMoney and formatMoneyPlain', () => {
    it('parses valid strings to minor units', () => {
      expect(parseMoney('12.34', 'USD')).toBe(1234n);
      expect(parseMoney('12.3', 'USD')).toBe(1230n);
      expect(parseMoney('12', 'USD')).toBe(1200n);
      expect(parseMoney('0.05', 'USD')).toBe(5n);
      expect(parseMoney('0', 'USD')).toBe(0n);
      expect(parseMoney('-12.34', 'USD')).toBe(-1234n);
      expect(parseMoney('100000', 'VND')).toBe(100000n);
    });

    it('rejects invalid money strings as specified', () => {
      expect(() => parseMoney('1.234', 'USD')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('1000.5', 'VND')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('1000.0', 'VND')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('', 'USD')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('1,234.56', 'USD')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('1e5', 'USD')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('NaN', 'USD')).toThrow(InvalidMoneyError);
      expect(() => parseMoney(' 12.34 ', 'USD')).toThrow(InvalidMoneyError);
    });

    it('formats money plainly without locale styling', () => {
      expect(formatMoneyPlain(money(1234n, 'USD'))).toBe('12.34');
      expect(formatMoneyPlain(money(5n, 'USD'))).toBe('0.05');
      expect(formatMoneyPlain(money(0n, 'USD'))).toBe('0.00');
      expect(formatMoneyPlain(money(-1234n, 'USD'))).toBe('-12.34');
      expect(formatMoneyPlain(money(100000n, 'VND'))).toBe('100000');
      expect(formatMoneyPlain(money(-100000n, 'VND'))).toBe('-100000');
    });
  });

  describe('FX conversion', () => {
    const validSnapshotOptions = {
      source: 'test-ecb',
      asOf: '2026-11-12T00:00:00Z',
    };

    it('returns input unchanged with rate 1 when same currency', () => {
      const m = money(1234n, 'USD');
      const res = convert(m, decimal('1.0'), 'USD', RoundingMode.HALF_UP);
      expect(res.converted.amountMinor).toBe(1234n);
      expect(res.converted.currency).toBe('USD');
      expect(res.snapshot.base).toBe('USD');
      expect(res.snapshot.quote).toBe('USD');
      expect(res.snapshot.rate).toBe('1');
    });

    it('converts across different currencies taking exponents into account', () => {
      // 1.00 USD (100 cents) -> VND at 25,400 VND/USD
      // USD has exp 2, VND has exp 0
      // 100 minor USD = 1 major USD -> 25,400 major VND = 25,400 minor VND
      const usd = money(100n, 'USD');
      const rate = decimal('25400');
      const res = convert(usd, rate, 'VND', RoundingMode.HALF_UP, validSnapshotOptions);
      expect(res.converted.amountMinor).toBe(25400n);
      expect(res.converted.currency).toBe('VND');
      expect(res.snapshot.rate).toBe('25400');
      expect(res.snapshot.source).toBe('test-ecb');
      expect(res.snapshot.asOf).toBe('2026-11-12T00:00:00Z');
    });

    it('converts VND to USD at rate 0.00004', () => {
      // 25,000 VND -> USD at 0.00004
      // 25,000 VND * 0.00004 = 1.00 USD = 100 cents
      const vnd = money(25000n, 'VND');
      const rate = decimal('0.00004');
      const res = convert(vnd, rate, 'USD', RoundingMode.HALF_UP, validSnapshotOptions);
      expect(res.converted.amountMinor).toBe(100n);
      expect(res.converted.currency).toBe('USD');
    });

    it('rejects cross-currency conversion with rate <= 0 (E1)', () => {
      const usd = money(100n, 'USD');
      expect(() =>
        convert(usd, decimal('0'), 'VND', RoundingMode.HALF_UP, validSnapshotOptions),
      ).toThrow(InvalidRateError);
      expect(() =>
        convert(usd, decimal('-1.5'), 'VND', RoundingMode.HALF_UP, validSnapshotOptions),
      ).toThrow(InvalidRateError);
    });

    it('rejects cross-currency conversion with missing or invalid source/asOf (E2)', () => {
      const usd = money(100n, 'USD');
      const rate = decimal('25400');

      // Missing options
      expect(() => convert(usd, rate, 'VND', RoundingMode.HALF_UP)).toThrow(InvalidRateError);

      // Missing or empty source
      expect(() =>
        convert(usd, rate, 'VND', RoundingMode.HALF_UP, {
          source: '',
          asOf: '2026-11-12T00:00:00Z',
        }),
      ).toThrow(InvalidRateError);

      // Missing or invalid asOf
      expect(() =>
        convert(usd, rate, 'VND', RoundingMode.HALF_UP, {
          source: 'ecb',
          asOf: '',
        }),
      ).toThrow(InvalidRateError);

      expect(() =>
        convert(usd, rate, 'VND', RoundingMode.HALF_UP, {
          source: 'ecb',
          asOf: 'not-an-iso-utc-string',
        }),
      ).toThrow(InvalidRateError);

      expect(() =>
        convert(usd, rate, 'VND', RoundingMode.HALF_UP, {
          source: 'ecb',
          asOf: '2026-11-12T00:00:00+07:00', // not UTC (must end in Z)
        }),
      ).toThrow(InvalidRateError);
    });
  });

  describe('JSON serialization', () => {
    it('round-trips through toJSON and fromJSON', () => {
      const original = money(1234n, 'USD');
      const json = toJSON(original);
      expect(json).toEqual({
        amountMinor: '1234',
        currency: 'USD',
      });

      const restored = fromJSON(json);
      expect(restored.amountMinor).toBe(original.amountMinor);
      expect(restored.currency).toBe(original.currency);
    });

    it('handles negative amounts and large integers in JSON', () => {
      const large = money(-9876543210987654321n, 'VND');
      const json = toJSON(large);
      expect(json.amountMinor).toBe('-9876543210987654321');
      const restored = fromJSON(json);
      expect(restored.amountMinor).toBe(large.amountMinor);
      expect(restored.currency).toBe('VND');
    });

    it('validates invalid JSON structures', () => {
      expect(() => fromJSON(null)).toThrow(InvalidMoneyError);
      expect(() => fromJSON({ amountMinor: '100' })).toThrow(InvalidMoneyError);
      expect(() => fromJSON({ amountMinor: 'abc', currency: 'USD' })).toThrow(InvalidMoneyError);
      expect(() => fromJSON({ amountMinor: '100', currency: 'INVALID' })).toThrow(
        UnsupportedCurrencyError,
      );
    });
  });
});
