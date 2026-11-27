import { t } from './translate.ts';

export interface CancellationPolicyRule {
  readonly hoursBeforeStart: number;
  readonly refundPercent: number;
}

export interface CancellationPolicySummary {
  readonly rules: readonly CancellationPolicyRule[];
  readonly weatherClause?: string | null;
}

/**
 * Formats structured cancellation policy rules into localized customer-facing
 * sentences shared between the web UI and transactional emails (U1).
 */
export function formatCancellationPolicySentences(
  summary: CancellationPolicySummary | null | undefined,
  locale: string,
): readonly string[] {
  if (!summary || summary.rules.length === 0) {
    return [t(locale, 'demo.detail.policyUnavailable')];
  }

  const sorted = [...summary.rules].sort((a, b) => b.hoursBeforeStart - a.hoursBeforeStart);
  const lines: string[] = [];

  for (let idx = 0; idx < sorted.length; idx++) {
    const rule = sorted[idx]!;
    if (rule.hoursBeforeStart === 0 && rule.refundPercent === 0) {
      const prevRule = idx > 0 ? sorted[idx - 1] : undefined;
      lines.push(
        t(locale, 'demo.detail.policyNoRefundAfter', {
          hours: prevRule ? prevRule.hoursBeforeStart : 0,
        }),
      );
      continue;
    }

    if (rule.refundPercent === 100) {
      lines.push(t(locale, 'demo.detail.policyFreeUntil', { hours: rule.hoursBeforeStart }));
    } else {
      lines.push(
        t(locale, 'demo.detail.policyRefundUntil', {
          percent: rule.refundPercent,
          hours: rule.hoursBeforeStart,
        }),
      );
    }
  }

  if (summary.weatherClause === 'full_refund_or_reschedule') {
    lines.push(t(locale, 'demo.detail.policyWeatherFullRefund'));
  } else if (summary.weatherClause && summary.weatherClause.trim().length > 0) {
    lines.push(summary.weatherClause.trim());
  }

  return lines;
}
