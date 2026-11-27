import type { IncomingHttpHeaders } from 'node:http';
import type { DatabaseTransaction, InboxMessage, OutboxEvent } from '@internationalota/db';

export interface EnqueueOutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Handler invoked by the outbox relay.
 *
 * IMPORTANT: Delivery is at-least-once (a crash between handler execution and
 * setting `published_at` will cause redelivery). All handlers MUST be idempotent.
 */
export type OutboxEventHandler = (event: OutboxEvent) => Promise<void>;

/**
 * Handler invoked by the inbox relay for verified provider webhooks.
 *
 * Runs inside the inbox relay's PostgreSQL savepoint transaction (`tx`) so business state,
 * ledger postings, outbox events, and `processed_at` commit atomically.
 * IMPORTANT: Delivery is at-least-once. All handlers MUST be idempotent.
 */
export type InboxMessageHandler = (message: InboxMessage, tx: DatabaseTransaction) => Promise<void>;

export interface WebhookVerificationResult {
  eventId: string;
  payload: Record<string, unknown>;
}

/**
 * Verifies an incoming webhook request for a specific external provider.
 *
 * Security requirements for real production provider adapters:
 * 1. Signature verification MUST run against the exact raw request bytes (`rawBody`).
 * 2. The deduplication `eventId` MUST be derived exclusively from cryptographically
 *    signed content (never from an unsigned header).
 * 3. Real provider adapters MUST also verify a provider-signed timestamp and enforce
 *    a bounded replay window (e.g. reject events older than 5 minutes) to prevent
 *    replay of captured historical requests.
 */
export interface WebhookVerifier {
  readonly provider: string;
  verify(rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerificationResult;
}

export interface OutboxRelayOptions {
  batchSize?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  /**
   * Optional test hook invoked immediately after a handler succeeds and
   * BEFORE `published_at` is persisted. Throwing here simulates a process
   * crash between handling and marking.
   */
  afterHandleHook?: (event: OutboxEvent) => Promise<void> | void;
}

export interface InboxRelayOptions {
  batchSize?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

const MAX_BACKOFF_MS = 3_600_000; // 1 hour cap

export function calculateExponentialBackoffMs(attempts: number, baseBackoffMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(MAX_BACKOFF_MS, baseBackoffMs * 2 ** exponent);
}

export const BOOKING_EXPIRY_WORKER_PORT = 'BOOKING_EXPIRY_WORKER_PORT';

export interface BookingExpiryWorkerPort {
  expireDue(options?: { readonly limit?: number }): Promise<{
    readonly expiredCount: number;
    readonly skippedCount: number;
  }>;
}

export const PAYMENT_RECONCILIATION_WORKER_PORT = 'PAYMENT_RECONCILIATION_WORKER_PORT';

export interface PaymentReconciliationWorkerPort {
  reconcilePending(options?: {
    readonly staleAfterMinutes?: number;
    readonly expireAfterMinutes?: number;
  }): Promise<{
    readonly checkedCount: number;
    readonly resolvedCount: number;
    readonly expiredCount: number;
  }>;
}

export const MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT = 'MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT';

export interface MockPspDelayedCallbackWorkerPort {
  deliverDelayedCallback(payload: Record<string, unknown>): Promise<void>;
}
