import type { IncomingHttpHeaders } from 'node:http';
import type { WebhookVerificationResult, WebhookVerifier } from '../messaging/index.js';

export type PaymentOutcome = 'succeeded' | 'failed';

export interface CreateCheckoutInput {
  readonly attemptId: string;
  readonly bookingReference: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly locale: string;
  readonly returnUrl: string;
}

export interface CreateCheckoutOutput {
  readonly providerRef: string;
  readonly redirectUrl: string;
}

export interface CreateRefundInput {
  readonly refundId: string;
  readonly providerRef: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reason: string;
}

export interface CreateRefundOutput {
  readonly providerRefundRef: string;
}

export interface PaymentVerificationResult {
  readonly eventId: string;
  readonly providerRef: string;
  readonly outcome: PaymentOutcome;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: string;
}

export interface RefundVerificationResult {
  readonly eventId: string;
  readonly providerRefundRef: string;
  readonly refundId?: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: string;
}

export interface PaymentProvider extends WebhookVerifier {
  readonly provider: string;
  readonly webhookSlug: string;
  getConfigSnapshot(): Record<string, unknown>;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutOutput>;
  refund(input: CreateRefundInput): Promise<CreateRefundOutput>;
  verify(rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerificationResult;
  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): PaymentVerificationResult;
  getStatus(providerRef: string): Promise<PaymentVerificationResult | 'pending'>;
}

export interface InitiateCheckoutRequestDto {
  readonly provider?: string;
  readonly returnUrl?: string;
}

export interface InitiateCheckoutResponseDto {
  readonly attemptId: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly redirectUrl: string;
}

export type MockPspAction =
  | 'success'
  | 'fail'
  | 'cancel'
  | 'duplicate'
  | 'delayed_3m'
  | 'wrong_amount'
  | 'refund_auto_succeed'
  | 'refund_auto_fail'
  | 'refund_delay';

export interface AdminRefundDto {
  readonly id: string;
  readonly bookingId: string;
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

export interface DepartureCancelRequestDto {
  readonly reason: string;
}

export interface DepartureCancelResultDto {
  readonly departureId: string;
  readonly departureStatus: 'cancelled';
  readonly reason: string;
  readonly activeHoldsCancelledCount: number;
  readonly confirmedJobsEnqueuedCount: number;
  readonly totalBookingsMatched: number;
}

export interface BookingCancellationPreviewDto {
  readonly status: string;
  readonly currency: string;
  readonly totalAmountMinor: string;
  readonly refundAmountMinor: string;
  readonly refundPercent?: number;
  readonly ruleApplied?: {
    readonly hoursBeforeStart: number;
    readonly refundPercent: number;
  } | null;
  readonly cancellable: boolean;
  readonly reason?: 'not_paid' | 'too_late_to_cancel' | 'already_cancelled' | 'not_cancellable';
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
