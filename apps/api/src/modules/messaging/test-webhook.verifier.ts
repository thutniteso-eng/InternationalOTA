import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { UnauthorizedException } from '@nestjs/common';
import type { WebhookVerificationResult, WebhookVerifier } from './messaging.types.js';

/**
 * Test webhook verifier using HMAC-SHA256 over the raw request bytes
 * with constant-time signature comparison and secret from `WEBHOOK_TEST_SECRET`.
 */
export class TestHmacWebhookVerifier implements WebhookVerifier {
  readonly provider = 'test';

  verify(rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerificationResult {
    const secret = process.env['WEBHOOK_TEST_SECRET'];
    if (!secret) {
      throw new UnauthorizedException('Webhook verification secret is not configured');
    }

    const rawSignature = headers['x-webhook-signature'];
    if (typeof rawSignature !== 'string' || rawSignature.length === 0) {
      throw new UnauthorizedException('Missing webhook signature');
    }

    const providedHex = rawSignature.startsWith('sha256=')
      ? rawSignature.slice('sha256='.length)
      : rawSignature;

    if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
      throw new UnauthorizedException('Invalid webhook signature format');
    }

    const expectedBuf = createHmac('sha256', secret).update(rawBody).digest();
    const providedBuf = Buffer.from(providedHex, 'hex');

    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid webhook JSON payload');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new UnauthorizedException('Webhook payload must be a JSON object');
    }

    const payload = parsed as Record<string, unknown>;
    const headerEventId = headers['x-webhook-id'];
    const bodyEventId = payload['id'];
    const eventId =
      typeof headerEventId === 'string' && headerEventId.length > 0
        ? headerEventId
        : typeof bodyEventId === 'string' && bodyEventId.length > 0
          ? bodyEventId
          : null;

    if (!eventId) {
      throw new UnauthorizedException('Webhook event ID is required');
    }

    return { eventId, payload };
  }
}
