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
}

export interface CustomerBookingListResponse {
  readonly items: readonly BookingDetailDto[];
  readonly nextCursor: string | null;
}

export interface AdminBookingListQuery {
  readonly status?: string;
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
