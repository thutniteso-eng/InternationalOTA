import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  convert,
  decimal,
  formatMoneyPlain,
  money,
  parseMoney,
  RoundingMode,
  sum,
  SUPPORTED_CURRENCIES,
  type CurrencyCode,
} from '../src/index.ts';

const currencies = Object.keys(SUPPORTED_CURRENCIES) as CurrencyCode[];

const currencyArb = fc.constantFrom(...currencies);
const roundingModeArb = fc.constantFrom(
  RoundingMode.HALF_UP,
  RoundingMode.HALF_EVEN,
  RoundingMode.DOWN,
  RoundingMode.UP,
);

const moneyArb = fc.record({
  amountMinor: fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
  currency: currencyArb,
});

describe('packages/money - Property-Based Tests (fast-check >= 1000 runs)', () => {
  it('allocate sum invariant: sum of parts strictly equals input amount (1000 runs)', () => {
    fc.assert(
      fc.property(
        moneyArb,
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 30 }),
        (data, ratios) => {
          const m = money(data.amountMinor, data.currency);
          const parts = allocate(m, ratios);
          expect(parts).toHaveLength(ratios.length);
          const totalAllocated = sum(parts, m.currency).amountMinor;
          expect(totalAllocated).toBe(m.amountMinor);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('add commutative property: add(a, b) === add(b, a) (1000 runs)', () => {
    fc.assert(
      fc.property(
        currencyArb,
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        (curr, amountA, amountB) => {
          const a = money(amountA, curr);
          const b = money(amountB, curr);
          const ab = add(a, b);
          const ba = add(b, a);
          expect(ab.amountMinor).toBe(ba.amountMinor);
          expect(ab.currency).toBe(curr);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('add associative property: add(add(a, b), c) === add(a, add(b, c)) (1000 runs)', () => {
    fc.assert(
      fc.property(
        currencyArb,
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        (curr, amountA, amountB, amountC) => {
          const a = money(amountA, curr);
          const b = money(amountB, curr);
          const c = money(amountC, curr);

          const left = add(add(a, b), c);
          const right = add(a, add(b, c));
          expect(left.amountMinor).toBe(right.amountMinor);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('parseMoney ∘ formatMoneyPlain round-trip for every supported currency (1000 runs)', () => {
    fc.assert(
      fc.property(
        currencyArb,
        fc.bigInt({ min: -10_000_000_000_000n, max: 10_000_000_000_000n }),
        (curr, amountMinor) => {
          const m = money(amountMinor, curr);
          const formatted = formatMoneyPlain(m);
          const parsed = parseMoney(formatted, curr);
          expect(parsed).toBe(amountMinor);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('convert with rate 1 is identity for any currency and rounding mode (1000 runs)', () => {
    const rateOne = decimal('1');
    fc.assert(
      fc.property(moneyArb, roundingModeArb, (data, mode) => {
        const m = money(data.amountMinor, data.currency);
        const { converted, snapshot } = convert(m, rateOne, m.currency, mode);
        expect(converted.amountMinor).toBe(m.amountMinor);
        expect(converted.currency).toBe(m.currency);
        expect(snapshot.rate).toBe('1');
        expect(snapshot.base).toBe(m.currency);
        expect(snapshot.quote).toBe(m.currency);
      }),
      { numRuns: 1000 },
    );
  });
});
