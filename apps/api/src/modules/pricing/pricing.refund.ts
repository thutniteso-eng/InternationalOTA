import { createMoney, roundFraction, RoundingMode } from '@internationalota/money';
import {
  pricingPolicyInvalidRuleCountException,
  pricingPolicyInvalidRuleValuesException,
  pricingPolicyMissingZeroHourRuleException,
  pricingPolicyNonMonotonicRefundException,
  pricingPolicyUnsortedRulesException,
} from './pricing.errors.js';
import type { CancellationRule, ComputeRefundInput, ComputeRefundResult } from './pricing.types.js';

const MS_PER_HOUR = 3_600_000n;
export const MAX_CANCELLATION_RULES = 10;

export function validateCancellationRules(rawRules: unknown): CancellationRule[] {
  if (!Array.isArray(rawRules)) {
    throw pricingPolicyInvalidRuleCountException();
  }
  if (rawRules.length === 0 || rawRules.length > MAX_CANCELLATION_RULES) {
    throw pricingPolicyInvalidRuleCountException();
  }

  const normalized: CancellationRule[] = rawRules.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw pricingPolicyInvalidRuleValuesException('each rule must be an object');
    }
    const obj = item as Record<string, unknown>;
    const hours = obj['hoursBeforeStart'];
    const percent = obj['refundPercent'];

    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 0) {
      throw pricingPolicyInvalidRuleValuesException('hoursBeforeStart must be an integer >= 0');
    }
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw pricingPolicyInvalidRuleValuesException('refundPercent must be an integer 0..100');
    }

    return {
      hoursBeforeStart: hours,
      refundPercent: percent,
    };
  });

  for (let i = 1; i < normalized.length; i++) {
    const prev = normalized[i - 1]!;
    const curr = normalized[i]!;
    if (curr.hoursBeforeStart >= prev.hoursBeforeStart) {
      throw pricingPolicyUnsortedRulesException();
    }
    if (curr.refundPercent > prev.refundPercent) {
      throw pricingPolicyNonMonotonicRefundException();
    }
  }

  const last = normalized[normalized.length - 1]!;
  if (last.hoursBeforeStart !== 0) {
    throw pricingPolicyMissingZeroHourRuleException();
  }

  return normalized;
}

function toTimestampMs(value: Date | string, label: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp for ${label}: ${String(value)}`);
  }
  return ms;
}

/**
 * Pure refund calculation using exact bigint arithmetic and RoundingMode.DOWN (floor)
 * so rounding never favours the platform beyond one minor unit.
 * Cancelling after departure start gives 0%.
 */
export function computeRefund(input: ComputeRefundInput): ComputeRefundResult {
  if (input.paidAmountMinor < 0n) {
    throw new Error('paidAmountMinor must be non-negative');
  }
  const paid = createMoney(input.paidAmountMinor, input.currency);
  const rules = validateCancellationRules(input.rules);

  const startsMs = toTimestampMs(input.startsAt, 'startsAt');
  const cancelledMs = toTimestampMs(input.cancelledAt, 'cancelledAt');
  const diffMs = BigInt(startsMs - cancelledMs);

  if (diffMs < 0n) {
    return {
      refundPercent: 0,
      refundAmountMinor: 0n,
      ruleApplied: null,
    };
  }

  let matched: CancellationRule = rules[rules.length - 1]!;
  for (const rule of rules) {
    if (diffMs >= BigInt(rule.hoursBeforeStart) * MS_PER_HOUR) {
      matched = rule;
      break;
    }
  }

  const refundAmountMinor = roundFraction(
    paid.amountMinor * BigInt(matched.refundPercent),
    100n,
    RoundingMode.DOWN,
  );

  return {
    refundPercent: matched.refundPercent,
    refundAmountMinor,
    ruleApplied: matched,
  };
}

export function isSameQuote(
  a: { readonly snapshotHash: string },
  b: { readonly snapshotHash: string },
): boolean {
  return a.snapshotHash === b.snapshotHash;
}
