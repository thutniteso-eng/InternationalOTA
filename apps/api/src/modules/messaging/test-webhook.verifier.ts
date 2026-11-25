import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { UnauthorizedException } from '@nestjs/common';
import type { WebhookVerificationResult, WebhookVerifier } from './messaging.types.js';

/**
 * Test-only webhook verifier (registered only when `NODE_ENV !== 'production'`).
 *
 * Uses HMAC-SHA256 over the raw request bytes with constant-time signature
 * comparison and secret from `WEBHOOK_TEST_SECRET`.
 *
 * The deduplication `eventId` is extracted exclusively from the signed JSON
 * body (`payload.id`) — never from unsigned headers — so an attacker cannot
 * bypass deduplication by varying unauthenticated headers.
 *
 * Note: Real provider adapters (Stripe, Momo, VNPay, suppliers) MUST also
 * verify a signed timestamp and enforce a replay window (not required for
 * this `test` fixture).
 */
export class TestHmacWebhookVerifier implements WebhookVerifier {
  readonly provider = 'test';

  verify(rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerificationResult {
    const secret = process.env['WEBHOOK_TEST_SECRET'];
    if (!secret) {
      throw new UnauthorizedException({
        message: 'Webhook verification secret is not configured',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    const rawSignature = headers['x-webhook-signature'];
    if (typeof rawSignature !== 'string' || rawSignature.length === 0) {
      throw new UnauthorizedException({
        message: 'Missing webhook signature',
        i18nKey: 'http.401.missingWebhookSignature',
      });
    }

    const providedHex = rawSignature.startsWith('sha256=')
      ? rawSignature.slice('sha256='.length)
      : rawSignature;

    if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
      throw new UnauthorizedException({
        message: 'Invalid webhook signature format',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    const expectedBuf = createHmac('sha256', secret).update(rawBody).digest();
    const providedBuf = Buffer.from(providedHex, 'hex');

    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw new UnauthorizedException({
        message: 'Invalid webhook signature',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException({
        message: 'Invalid webhook JSON payload',
        i18nKey: 'http.401.invalidWebhookPayload',
      });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new UnauthorizedException({
        message: 'Webhook payload must be a JSON object',
        i18nKey: 'http.401.invalidWebhookPayload',
      });
    }

    const payload = parsed as Record<string, unknown>;
    const bodyEventId = payload['id'];
    const eventId = typeof bodyEventId === 'string' && bodyEventId.length > 0 ? bodyEventId : null;

    if (!eventId) {
      throw new UnauthorizedException({
        message: 'Signed webhook body must contain a non-empty string "id"',
        i18nKey: 'http.401.invalidWebhookPayload',
      });
    }

    return { eventId, payload };
  }
}
