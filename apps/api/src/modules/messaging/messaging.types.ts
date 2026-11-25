import type { IncomingHttpHeaders } from 'node:http';
import type { InboxMessage, OutboxEvent } from '@internationalota/db';

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
 * IMPORTANT: Delivery is at-least-once. All handlers MUST be idempotent.
 */
export type InboxMessageHandler = (message: InboxMessage) => Promise<void>;

export interface WebhookVerificationResult {
  eventId: string;
  payload: Record<string, unknown>;
}

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
