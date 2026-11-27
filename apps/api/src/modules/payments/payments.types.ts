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

export interface PaymentVerificationResult {
  readonly eventId: string;
  readonly providerRef: string;
  readonly outcome: PaymentOutcome;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: string;
}

export interface PaymentProvider extends WebhookVerifier {
  readonly provider: string;
  readonly webhookSlug: string;
  getConfigSnapshot(): Record<string, unknown>;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutOutput>;
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
  'success' | 'fail' | 'cancel' | 'duplicate' | 'delayed_3m' | 'wrong_amount';
