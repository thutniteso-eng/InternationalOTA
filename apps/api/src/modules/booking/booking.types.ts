import type { BookingPaxJson, BookingStatus } from '@internationalota/db';
import type { PublicQuoteResponse, QuoteSnapshot } from '../pricing/index.js';

export interface BookingContactInput {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly locale?: string;
}

export interface CreateHoldInput {
  readonly customerUserId: string;
  readonly departureId: string;
  readonly pax: BookingPaxJson;
  readonly contact: BookingContactInput;
  readonly expectedSnapshotHash: string;
  readonly acceptLanguage?: string | string[];
}

export interface HoldBookingResponseDto {
  readonly id: string;
  readonly reference: string;
  readonly status: BookingStatus;
  readonly holdExpiresAt: string;
  readonly totalAmountMinor: string;
  readonly currency: string;
  readonly seats: number;
  readonly quote: PublicQuoteResponse;
}

export interface BookingEventDto {
  readonly id: string;
  readonly fromStatus: BookingStatus | null;
  readonly toStatus: BookingStatus;
  readonly actor: string;
  readonly reason: string | null;
  readonly at: string;
}

export interface BookingPaymentSummaryDto {
  readonly status: string | null;
  readonly attemptCount: number;
}

export interface BookingRefundSummaryDto {
  readonly amountMinor: string;
  readonly status: string;
}

export const BOOKING_PAYMENT_SUMMARY_PORT = 'BOOKING_PAYMENT_SUMMARY_PORT';

export interface BookingPaymentSummaryPort {
  getPaymentSummaryForBooking(bookingId: string): Promise<BookingPaymentSummaryDto>;
  getRefundSummaryForBooking?(bookingId: string): Promise<BookingRefundSummaryDto | null>;
}

export const CONFIRMED_BOOKING_CANCELLATION_PORT = 'CONFIRMED_BOOKING_CANCELLATION_PORT';

export interface ConfirmedCancelResponseDto extends BookingDetailDto {
  readonly refundAmountMinor: string;
  readonly refundPercent: number;
  readonly ruleApplied: {
    readonly hoursBeforeStart: number;
    readonly refundPercent: number;
  } | null;
}

export interface ConfirmedBookingCancellationPort {
  cancelConfirmedBooking(
    reference: string,
    customerUserId: string,
  ): Promise<ConfirmedCancelResponseDto>;
}

export interface BookingDetailDto {
  readonly id: string;
  readonly reference: string;
  readonly customerUserId: string;
  readonly productId: string;
  readonly departureId: string;
  readonly status: BookingStatus;
  readonly pax: BookingPaxJson;
  readonly seats: number;
  readonly currency: string;
  readonly totalAmountMinor: string;
  readonly quoteSnapshot: QuoteSnapshot;
  readonly snapshotHash: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly contactLocale: string;
  readonly holdExpiresAt: string;
  readonly paymentRef: string | null;
  readonly version: number;
  readonly confirmedAt: string | null;
  readonly expiredAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events?: readonly BookingEventDto[];
  readonly payment?: BookingPaymentSummaryDto;
  readonly refund?: BookingRefundSummaryDto;
}

export interface CustomerBookingListResponse {
  readonly items: readonly BookingDetailDto[];
  readonly nextCursor: string | null;
}

export interface AdminBookingListQuery {
  readonly status?: string;
  readonly productId?: string;
  readonly departureId?: string;
  readonly reference?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

export type CreateHoldResult =
  | { readonly ok: true; readonly booking: HoldBookingResponseDto }
  | {
      readonly ok: false;
      readonly reason: 'price_changed';
      readonly quote: PublicQuoteResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        'sold_out' | 'closed' | 'cutoff_passed' | 'not_found' | 'too_many_active_holds';
    };

export type MarkPaymentPendingResult =
  | { readonly ok: true; readonly booking: BookingDetailDto }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'email_not_verified' | 'conflict';
    };

export type ConfirmBookingResult =
  | { readonly ok: true; readonly booking: BookingDetailDto }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'not_confirmable';
    };

export type CancelBookingResult =
  | { readonly ok: true; readonly booking: BookingDetailDto }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'not_cancellable';
    };

export interface BookingExpiryResult {
  readonly expiredCount: number;
  readonly skippedCount: number;
}

export interface BookingNotificationContext {
  readonly booking: BookingDetailDto;
  readonly cancellationReason: string | null;
}

export interface BookingSeatSumsPort {
  getActiveSeatSumsByDeparture(): Promise<ReadonlyMap<string, number>>;
}

export interface LedgerBookingExpectationPort {
  getConfirmedTotalsByCurrency(asOf: Date): Promise<ReadonlyMap<string, bigint>>;
}

export interface BookingReconciliationSnapshot {
  readonly id: string;
  readonly reference: string;
  readonly status: BookingStatus;
  readonly totalAmountMinor: bigint;
  readonly currency: string;
  readonly paymentRef: string | null;
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

export interface BookingAdminPaymentPort {
  getAdminBookingRecords(bookingId: string): Promise<{
    readonly attempts: readonly AdminBookingAttemptSummary[];
    readonly refunds: readonly AdminBookingRefundSummary[];
  }>;
}

export interface AdminBookingDetailEmailDto {
  readonly id: string;
  readonly template: string;
  readonly locale: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface AdminBookingDetailDto extends BookingDetailDto {
  readonly attempts: readonly AdminBookingAttemptSummary[];
  readonly refunds: readonly AdminBookingRefundSummary[];
  readonly emails: readonly AdminBookingDetailEmailDto[];
}

export interface AdminBookingDashboardWindowStats {
  readonly byStatus: Record<BookingStatus, number>;
  readonly totalBookings: number;
  readonly confirmedRevenueByCurrency: readonly {
    readonly currency: string;
    readonly totalAmountMinor: string;
  }[];
}

export interface AdminBookingDashboardMetrics {
  readonly today: AdminBookingDashboardWindowStats;
  readonly last7Days: AdminBookingDashboardWindowStats;
}

/**
 * Informational booking outbox event types intentionally emitted without an
 * in-process consumer yet.
 */
export const BOOKING_OUTBOX_EVENTS_WITHOUT_CONSUMERS = ['booking.payment_pending'] as const;
