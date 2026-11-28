import { formatMoney, type BuiltinLocale } from '@internationalota/i18n';
import { createMoney, type CurrencyCode } from '@internationalota/money';
import type { BookingDetailDto, BookingStatus, CustomerBookingListResponse } from './booking-api';

export interface AdminBookingWindowStats {
  readonly byStatus: Record<BookingStatus, number>;
  readonly totalBookings: number;
  readonly confirmedRevenueByCurrency: readonly {
    readonly currency: string;
    readonly totalAmountMinor: string;
  }[];
}

export interface ReconciliationRunCounts {
  readonly errors: number;
  readonly warnings: number;
  readonly checks: number;
  readonly totalFindings: number;
}

export interface ReconciliationRunDto {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly asOf: string;
  readonly status: string;
  readonly counts: ReconciliationRunCounts;
  readonly triggeredBy: string;
}

export interface AdminDashboardDto {
  readonly today: AdminBookingWindowStats;
  readonly last7Days: AdminBookingWindowStats;
  readonly latestReconciliation: ReconciliationRunDto | null;
  readonly pendingRefundsCount: number;
}

export interface AdminBookingAttemptSummary {
  readonly id: string;
  readonly provider: string;
  readonly providerRef: string | null;
  readonly amountMinor: string;
  readonly currency: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface AdminBookingRefundSummary {
  readonly id: string;
  readonly paymentAttemptId: string;
  readonly provider: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly reason: string;
  readonly status: string;
  readonly providerRefundRef: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AdminBookingEmailSummary {
  readonly id: string;
  readonly template: string;
  readonly locale: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface AdminBookingEventSummary {
  readonly id: string;
  readonly fromStatus: BookingStatus | null;
  readonly toStatus: BookingStatus;
  readonly actor: string;
  readonly reason: string | null;
  readonly at: string;
}

export interface AdminBookingDetailDto extends BookingDetailDto {
  readonly events?: readonly AdminBookingEventSummary[];
  readonly attempts: readonly AdminBookingAttemptSummary[];
  readonly refunds: readonly AdminBookingRefundSummary[];
  readonly emails: readonly AdminBookingEmailSummary[];
}

export interface AdminRefundWithBookingDto {
  readonly id: string;
  readonly bookingId: string;
  readonly bookingReference: string | null;
  readonly paymentAttemptId: string;
  readonly provider: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly reason: string;
  readonly status: string;
  readonly providerRefundRef: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AdminRefundListResponse {
  readonly items: readonly AdminRefundWithBookingDto[];
  readonly nextCursor: string | null;
}

export interface AdminProductOption {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly region: string | null;
  readonly translations?: Readonly<
    Record<string, { readonly title?: string; readonly slug?: string }>
  >;
  readonly slug?: string;
}

export interface AdminDepartureDto {
  readonly id: string;
  readonly productId: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly startsAt: string;
  readonly capacity: number;
  readonly allocated: number;
  readonly remaining: number;
  readonly status: 'open' | 'closed' | 'cancelled';
  readonly bookingCutoffMinutes: number;
}

export interface DepartureCancellationSummaryDto {
  readonly departureId: string;
  readonly departureStatus: string;
  readonly bookings: {
    readonly total: number;
    readonly confirmed: number;
    readonly cancelled: number;
    readonly held: number;
    readonly paymentPending: number;
    readonly expired: number;
  };
  readonly refunds: {
    readonly total: number;
    readonly requested: number;
    readonly processing: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly manualReview: number;
  };
}

export interface DepartureCancelResultDto {
  readonly departureId: string;
  readonly departureStatus: 'cancelled';
  readonly reason: string;
  readonly activeHoldsCancelledCount: number;
  readonly confirmedJobsEnqueuedCount: number;
  readonly totalBookingsMatched: number;
}

export interface ReconciliationFindingDto {
  readonly id: string;
  readonly runId: string;
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly entityType: string;
  readonly entityId: string;
  readonly details: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ReconciliationFindingGroupDto {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly count: number;
  readonly items: readonly ReconciliationFindingDto[];
}

export interface ReconciliationRunDetailDto {
  readonly run: ReconciliationRunDto;
  readonly findings: readonly ReconciliationFindingDto[];
  readonly groupedFindings: readonly ReconciliationFindingGroupDto[];
}

export interface ReconciliationRunListResponse {
  readonly items: readonly ReconciliationRunDto[];
  readonly nextCursor: string | null;
}

export type AdminApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code?: string;
      readonly message?: string;
    };

export function createAdminIdempotencyKey(prefix = 'admin-ui'): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function adminApiFetch<T>(
  path: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch,
): Promise<AdminApiResult<T>> {
  const res = await fetchFn(path, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code =
      typeof body?.['code'] === 'string'
        ? body['code']
        : typeof body?.['errorCode'] === 'string'
          ? body['errorCode']
          : undefined;
    const message =
      typeof body?.['detail'] === 'string'
        ? body['detail']
        : typeof body?.['message'] === 'string'
          ? body['message']
          : undefined;
    return {
      ok: false,
      status: res.status,
      ...(code ? { code } : {}),
      ...(message ? { message } : {}),
    };
  }
  return { ok: true, status: res.status, data: body as T };
}

export function formatAdminMoneyMinor(
  amountMinor: string,
  currency: string,
  locale: BuiltinLocale,
): string {
  try {
    return formatMoney(createMoney(BigInt(amountMinor), currency as CurrencyCode), locale);
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

export function extractBookingReferenceFromFinding(
  finding: ReconciliationFindingDto,
): string | null {
  const ref = finding.details['reference'] ?? finding.details['bookingReference'];
  return typeof ref === 'string' && ref.trim().length > 0 ? ref.trim() : null;
}

export type { CustomerBookingListResponse };
