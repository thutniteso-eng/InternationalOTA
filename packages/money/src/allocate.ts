import { createMoney, type Money } from './money.ts';
import { InvalidMoneyError } from './errors.ts';

export function allocate(m: Money, ratios: readonly bigint[]): Money[] {
  if (ratios.length === 0) {
    throw new InvalidMoneyError('allocate requires a non-empty ratios array');
  }

  let totalWeight = 0n;
  for (const r of ratios) {
    if (r < 0n) {
      throw new InvalidMoneyError('allocate ratios must be non-negative');
    }
    totalWeight += r;
  }

  if (totalWeight === 0n) {
    throw new InvalidMoneyError('Sum of allocate ratios must be greater than zero');
  }

  const sign = m.amountMinor < 0n ? -1n : 1n;
  const absAmount = m.amountMinor < 0n ? -m.amountMinor : m.amountMinor;

  const n = ratios.length;
  const quotients: bigint[] = new Array(n) as bigint[];
  const remainders: bigint[] = new Array(n) as bigint[];

  let quotientSum = 0n;
  for (let i = 0; i < n; i++) {
    const ratio = ratios[i]!;
    const product = absAmount * ratio;
    const q = product / totalWeight;
    const r = product % totalWeight;
    quotients[i] = q;
    remainders[i] = r;
    quotientSum += q;
  }

  let remainderUnits = absAmount - quotientSum;

  // Indices sorted by remainder descending, tie-break by index ascending
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => {
    const remA = remainders[a]!;
    const remB = remainders[b]!;
    if (remA > remB) return -1;
    if (remA < remB) return 1;
    return a - b;
  });

  const bonusIndices = new Set<number>();
  for (let i = 0; remainderUnits > 0n && i < indices.length; i++) {
    bonusIndices.add(indices[i]!);
    remainderUnits -= 1n;
  }

  const result: Money[] = [];
  for (let i = 0; i < n; i++) {
    const bonus = bonusIndices.has(i) ? 1n : 0n;
    const share = sign * (quotients[i]! + bonus);
    result.push(createMoney(share, m.currency));
  }

  return result;
}
