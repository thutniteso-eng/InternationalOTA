import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  type DatabaseClient,
  eq,
  type MockPspRefundMode,
  type MockPspTransactionRow,
  paymentsMockPspRefunds,
  paymentsMockPspTransactions,
  sql,
} from '@internationalota/db';
import { formatMoney, negotiateLocale, t } from '@internationalota/i18n';
import { type CurrencyCode, createMoney } from '@internationalota/money';
import { resolveAppEnv } from '@internationalota/shared';
import { Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  JobQueueService,
  type MockPspDelayedCallbackWorkerPort,
  QUEUE_MOCK_PSP_DELAYED_CALLBACK,
  type WebhookVerificationResult,
} from '../messaging/index.js';
import { mockTransactionNotFoundException } from './payments.errors.js';
import type {
  CreateCheckoutInput,
  CreateCheckoutOutput,
  CreateRefundInput,
  CreateRefundOutput,
  MockPspAction,
  PaymentOutcome,
  PaymentProvider,
  PaymentVerificationResult,
  RefundVerificationResult,
} from './payments.types.js';

const MIN_SECRET_LENGTH = 32;
const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const DELAYED_CALLBACK_SECONDS = 180;
const SUPPORTED_LOCALES = ['vi', 'en'] as const;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseNonNegativeMinor(raw: unknown): bigint | null {
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return BigInt(raw);
  }
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
    return BigInt(raw);
  }
  return null;
}

@Injectable()
export class MockPaymentProvider implements PaymentProvider, MockPspDelayedCallbackWorkerPort {
  readonly provider = 'mock';
  readonly webhookSlug = 'mock-psp';
  private readonly logger = new Logger(MockPaymentProvider.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    @Optional() private readonly jobQueueService?: JobQueueService,
  ) {}

  isAvailable(): boolean {
    if (resolveAppEnv() === 'production') {
      return false;
    }
    return this.getSecret() !== null;
  }

  private getSecret(): string | null {
    if (resolveAppEnv() === 'production') {
      return null;
    }
    const raw = process.env['MOCK_PSP_SECRET']?.trim() ?? '';
    return raw.length >= MIN_SECRET_LENGTH ? raw : null;
  }

  private requireSecret(): string {
    if (resolveAppEnv() === 'production') {
      throw new Error('MockPaymentProvider cannot be used when APP_ENV=production');
    }
    const secret = this.getSecret();
    if (!secret) {
      throw new Error('MOCK_PSP_SECRET (>= 32 chars) is required for MockPaymentProvider');
    }
    return secret;
  }

  getConfigSnapshot(): Record<string, unknown> {
    return {
      provider: 'mock',
      mode: 'simulator',
      version: 1,
    };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutOutput> {
    this.requireSecret();
    const providerRef = `mock_${randomUUID().replace(/-/g, '')}`;

    await this.db.insert(paymentsMockPspTransactions).values({
      providerRef,
      attemptId: input.attemptId,
      bookingReference: input.bookingReference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      locale: input.locale,
      returnUrl: input.returnUrl,
      status: 'pending',
    });

    return {
      providerRef,
      redirectUrl: `/mock-psp/checkout/${providerRef}`,
    };
  }

  verify(rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerificationResult {
    const body = this.verifyHmacAndParseJson(rawBody, headers);
    const eventType = typeof body['eventType'] === 'string' ? body['eventType'].trim() : '';

    if (eventType === 'refund.succeeded' || eventType === 'refund.failed') {
      const parsedRefund = this.parseRefundPayload(body);
      return {
        eventId: parsedRefund.eventId,
        payload: body,
      };
    }

    const parsedPayment = this.parsePaymentPayload(body);
    return {
      eventId: parsedPayment.eventId,
      payload: body,
    };
  }

  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): PaymentVerificationResult {
    const body = this.verifyHmacAndParseJson(rawBody, headers);
    return this.parsePaymentPayload(body);
  }

  verifyRefundWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): RefundVerificationResult {
    const body = this.verifyHmacAndParseJson(rawBody, headers);
    return this.parseRefundPayload(body);
  }

  private verifyHmacAndParseJson(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): Record<string, unknown> {
    const secret = this.getSecret();
    if (!secret) {
      throw new UnauthorizedException({
        message: 'Mock webhook verifier is disabled',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    const rawSigHeader = headers['x-mock-signature'];
    const rawTsHeader = headers['x-mock-timestamp'];
    const rawSignature = typeof rawSigHeader === 'string' ? rawSigHeader.trim() : '';
    const rawTimestamp = typeof rawTsHeader === 'string' ? rawTsHeader.trim() : '';

    if (!rawSignature || !rawTimestamp) {
      throw new UnauthorizedException({
        message: 'Missing mock webhook signature or timestamp header',
        i18nKey: 'http.401.missingWebhookSignature',
      });
    }

    if (!/^\d+$/.test(rawTimestamp)) {
      throw new UnauthorizedException({
        message: 'Invalid mock webhook timestamp',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    const timestampSec = Number.parseInt(rawTimestamp, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(timestampSec) ||
      Math.abs(nowSec - timestampSec) > MAX_TIMESTAMP_SKEW_SECONDS
    ) {
      throw new UnauthorizedException({
        message: 'Mock webhook timestamp outside replay window',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    const providedHex = rawSignature.startsWith('sha256=')
      ? rawSignature.slice('sha256='.length)
      : rawSignature;
    if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
      throw new UnauthorizedException({
        message: 'Invalid mock webhook signature format',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    const signedBytes = Buffer.concat([Buffer.from(`${rawTimestamp}.`, 'utf8'), rawBody]);
    const expectedDigest = createHmac('sha256', secret).update(signedBytes).digest();
    const providedDigest = Buffer.from(providedHex, 'hex');

    if (
      expectedDigest.length !== providedDigest.length ||
      !timingSafeEqual(expectedDigest, providedDigest)
    ) {
      throw new UnauthorizedException({
        message: 'Invalid mock webhook signature',
        i18nKey: 'http.401.invalidWebhookSignature',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException({
        message: 'Invalid mock webhook JSON payload',
        i18nKey: 'http.401.invalidWebhookPayload',
      });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new UnauthorizedException({
        message: 'Mock webhook payload must be a JSON object',
        i18nKey: 'http.401.invalidWebhookPayload',
      });
    }

    return parsed as Record<string, unknown>;
  }

  private parsePaymentPayload(body: Record<string, unknown>): PaymentVerificationResult {
    const eventId =
      typeof body['eventId'] === 'string' && body['eventId'].trim() ? body['eventId'].trim() : null;
    const providerRef =
      typeof body['providerRef'] === 'string' && body['providerRef'].trim()
        ? body['providerRef'].trim()
        : null;
    const outcome =
      body['outcome'] === 'succeeded' || body['outcome'] === 'failed' ? body['outcome'] : null;
    const amountMinor = parseNonNegativeMinor(body['amountMinor']);
    const currency =
      typeof body['currency'] === 'string' && /^[A-Z]{3}$/.test(body['currency'].trim())
        ? body['currency'].trim()
        : null;
    const occurredAt =
      typeof body['occurredAt'] === 'string' && !Number.isNaN(Date.parse(body['occurredAt']))
        ? body['occurredAt']
        : null;

    if (!eventId || !providerRef || !outcome || amountMinor === null || !currency || !occurredAt) {
      throw new UnauthorizedException({
        message: 'Invalid mock webhook payload fields',
        i18nKey: 'http.401.invalidWebhookPayload',
      });
    }

    return {
      eventId,
      providerRef,
      outcome,
      amountMinor,
      currency,
      occurredAt,
    };
  }

  private parseRefundPayload(body: Record<string, unknown>): RefundVerificationResult {
    const eventId =
      typeof body['eventId'] === 'string' && body['eventId'].trim() ? body['eventId'].trim() : null;
    const providerRefundRef =
      typeof body['providerRefundRef'] === 'string' && body['providerRefundRef'].trim()
        ? body['providerRefundRef'].trim()
        : null;
    const refundId =
      typeof body['refundId'] === 'string' && body['refundId'].trim()
        ? body['refundId'].trim()
        : undefined;
    const eventType = typeof body['eventType'] === 'string' ? body['eventType'].trim() : '';
    const outcome =
      eventType === 'refund.succeeded' || body['outcome'] === 'succeeded'
        ? 'succeeded'
        : eventType === 'refund.failed' || body['outcome'] === 'failed'
          ? 'failed'
          : null;
    const amountMinor = parseNonNegativeMinor(body['amountMinor']);
    const currency =
      typeof body['currency'] === 'string' && /^[A-Z]{3}$/.test(body['currency'].trim())
        ? body['currency'].trim()
        : null;
    const occurredAt =
      typeof body['occurredAt'] === 'string' && !Number.isNaN(Date.parse(body['occurredAt']))
        ? body['occurredAt']
        : null;

    if (
      !eventId ||
      !providerRefundRef ||
      !outcome ||
      amountMinor === null ||
      !currency ||
      !occurredAt
    ) {
      throw new UnauthorizedException({
        message: 'Invalid mock refund webhook payload fields',
        i18nKey: 'http.401.invalidWebhookPayload',
      });
    }

    return {
      eventId,
      providerRefundRef,
      ...(refundId ? { refundId } : {}),
      outcome,
      amountMinor,
      currency,
      occurredAt,
    };
  }

  private resolveEffectiveRefundMode(txRow?: MockPspTransactionRow): MockPspRefundMode {
    const envKnob = process.env['MOCK_PSP_REFUND_MODE']?.trim();
    if (envKnob === 'auto_succeed' || envKnob === 'auto_fail' || envKnob === 'delay') {
      return envKnob;
    }
    if (
      txRow &&
      (txRow.refundMode === 'auto_succeed' ||
        txRow.refundMode === 'auto_fail' ||
        txRow.refundMode === 'delay')
    ) {
      return txRow.refundMode;
    }
    return 'auto_succeed';
  }

  async refund(input: CreateRefundInput): Promise<CreateRefundOutput> {
    this.requireSecret();

    const [existing] = await this.db
      .select()
      .from(paymentsMockPspRefunds)
      .where(eq(paymentsMockPspRefunds.refundId, input.refundId))
      .limit(1);

    const [txRow] = await this.db
      .select()
      .from(paymentsMockPspTransactions)
      .where(eq(paymentsMockPspTransactions.providerRef, input.providerRef))
      .limit(1);

    const mode = this.resolveEffectiveRefundMode(txRow);
    if (mode === 'auto_fail') {
      throw new Error('Mock PSP simulated refund failure');
    }

    const providerRefundRef =
      existing?.providerRefundRef ?? `mref_${randomUUID().replace(/-/g, '')}`;
    const eventId = randomUUID();
    const now = new Date();
    const status = mode === 'delay' ? 'pending' : 'succeeded';

    if (!existing) {
      await this.db
        .insert(paymentsMockPspRefunds)
        .values({
          providerRefundRef,
          refundId: input.refundId,
          providerRef: input.providerRef,
          amountMinor: input.amountMinor,
          currency: input.currency,
          status,
          lastEventId: eventId,
          occurredAt: now,
        })
        .onConflictDoNothing();
    }

    if (this.jobQueueService?.isStarted()) {
      const callbackUrl =
        process.env['MOCK_PSP_CALLBACK_URL']?.trim() ||
        `http://127.0.0.1:${process.env['API_PORT'] ?? 4000}/webhooks/mock-psp`;
      await this.jobQueueService.sendJob(
        QUEUE_MOCK_PSP_DELAYED_CALLBACK,
        {
          kind: 'refund',
          providerRefundRef,
          callbackUrl,
        },
        { startAfter: mode === 'delay' ? DELAYED_CALLBACK_SECONDS : 1 },
      );
    }

    return { providerRefundRef };
  }

  buildSignedRefundCallback(payload: {
    readonly eventId: string;
    readonly providerRefundRef: string;
    readonly refundId?: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly occurredAt: string;
    readonly timestampSec?: number;
  }): { rawBody: string; headers: Record<string, string> } {
    const secret = this.requireSecret();
    const timestamp = (payload.timestampSec ?? Math.floor(Date.now() / 1000)).toString();
    const rawBody = JSON.stringify({
      eventId: payload.eventId,
      eventType: payload.outcome === 'succeeded' ? 'refund.succeeded' : 'refund.failed',
      providerRefundRef: payload.providerRefundRef,
      ...(payload.refundId ? { refundId: payload.refundId } : {}),
      outcome: payload.outcome,
      amountMinor: payload.amountMinor.toString(),
      currency: payload.currency.trim(),
      occurredAt: payload.occurredAt,
    });
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    return {
      rawBody,
      headers: {
        'Content-Type': 'application/json',
        'x-mock-signature': signature,
        'x-mock-timestamp': timestamp,
      },
    };
  }

  async deliverPendingRefundCallback(
    providerRefundRef: string,
    callbackUrl: string,
    outcomeOverride?: 'succeeded' | 'failed',
  ): Promise<void> {
    if (resolveAppEnv() === 'production') {
      return;
    }
    const [refundRow] = await this.db
      .select()
      .from(paymentsMockPspRefunds)
      .where(eq(paymentsMockPspRefunds.providerRefundRef, providerRefundRef))
      .limit(1);
    if (!refundRow) {
      return;
    }

    const effectiveOutcome: 'succeeded' | 'failed' =
      outcomeOverride ?? (refundRow.status === 'failed' ? 'failed' : 'succeeded');

    if (refundRow.status === 'pending' || outcomeOverride) {
      await this.db
        .update(paymentsMockPspRefunds)
        .set({
          status: effectiveOutcome,
          updatedAt: sql`now()`,
        })
        .where(eq(paymentsMockPspRefunds.id, refundRow.id));
    }

    const signed = this.buildSignedRefundCallback({
      eventId: outcomeOverride ? randomUUID() : (refundRow.lastEventId ?? randomUUID()),
      providerRefundRef: refundRow.providerRefundRef,
      refundId: refundRow.refundId,
      outcome: effectiveOutcome,
      amountMinor: refundRow.amountMinor,
      currency: refundRow.currency,
      occurredAt: (refundRow.occurredAt ?? new Date()).toISOString(),
    });

    await this.postCallbackToWebhook(callbackUrl, signed);
  }

  async getStatus(providerRef: string): Promise<PaymentVerificationResult | 'pending'> {
    this.requireSecret();
    const [txRow] = await this.db
      .select()
      .from(paymentsMockPspTransactions)
      .where(eq(paymentsMockPspTransactions.providerRef, providerRef))
      .limit(1);

    if (!txRow || txRow.status === 'pending') {
      return 'pending';
    }

    return {
      eventId: txRow.lastEventId ?? `status_${txRow.providerRef}`,
      providerRef: txRow.providerRef,
      outcome: txRow.status as PaymentOutcome,
      amountMinor: txRow.amountMinor,
      currency: txRow.currency.trim(),
      occurredAt: (txRow.occurredAt ?? txRow.updatedAt).toISOString(),
    };
  }

  async getTransactionForHostedPage(providerRef: string): Promise<MockPspTransactionRow> {
    this.requireSecret();
    const [row] = await this.db
      .select()
      .from(paymentsMockPspTransactions)
      .where(eq(paymentsMockPspTransactions.providerRef, providerRef))
      .limit(1);

    if (!row) {
      throw mockTransactionNotFoundException();
    }
    return row;
  }

  renderCheckoutHtml(txRow: MockPspTransactionRow, acceptLanguage?: string): string {
    const locale = negotiateLocale(txRow.locale || acceptLanguage, SUPPORTED_LOCALES, 'en');
    const formattedAmount = formatMoney(
      createMoney(txRow.amountMinor, txRow.currency.trim() as CurrencyCode),
      locale,
    );
    const title = escapeHtml(t(locale, 'payments.mock.title'));
    const subtitle = escapeHtml(t(locale, 'payments.mock.subtitle'));
    const refLabel = escapeHtml(t(locale, 'payments.mock.bookingReferenceLabel'));
    const amountLabel = escapeHtml(t(locale, 'payments.mock.amountLabel'));
    const statusLabel = escapeHtml(t(locale, 'payments.mock.statusLabel'));
    const refundModeLabel = escapeHtml(t(locale, 'payments.mock.refundModeLabel'));
    const actionUrl = escapeHtml(`/mock-psp/checkout/${txRow.providerRef}/action`);

    return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — ${escapeHtml(txRow.bookingReference)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 16px; color: #111827; background: #f9fafb; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .badge { display: inline-block; background: #fef3c7; color: #92400e; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .meta { margin: 16px 0; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; padding: 12px 0; }
    .row { display: flex; justify-content: space-between; padding: 6px 0; }
    .actions { display: grid; gap: 10px; margin-top: 16px; }
    button { width: 100%; padding: 11px 16px; border-radius: 8px; border: 1px solid transparent; font-size: 15px; font-weight: 600; cursor: pointer; }
    .btn-success { background: #059669; color: #fff; }
    .btn-fail { background: #dc2626; color: #fff; }
    .btn-cancel { background: #fff; color: #374151; border-color: #d1d5db; }
    .dev { margin-top: 24px; padding-top: 16px; border-top: 1px dashed #d1d5db; }
    .dev h2 { font-size: 13px; text-transform: uppercase; color: #6b7280; margin: 0 0 10px; }
    .btn-dev { background: #f3f4f6; color: #1f2937; border-color: #d1d5db; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">DEMO / MOCK PSP</span>
    <h1>${title}</h1>
    <p>${subtitle}</p>
    <div class="meta">
      <div class="row"><span>${refLabel}</span><strong>${escapeHtml(txRow.bookingReference)}</strong></div>
      <div class="row"><span>${amountLabel}</span><strong>${escapeHtml(formattedAmount)}</strong></div>
      <div class="row"><span>${statusLabel}</span><code>${escapeHtml(txRow.status)}</code></div>
      <div class="row"><span>${refundModeLabel}</span><code>${escapeHtml(txRow.refundMode)}</code></div>
    </div>
    <div class="actions">
      <form method="post" action="${actionUrl}">
        <input type="hidden" name="action" value="success" />
        <button class="btn-success" type="submit">${escapeHtml(t(locale, 'payments.mock.paySuccess'))}</button>
      </form>
      <form method="post" action="${actionUrl}">
        <input type="hidden" name="action" value="fail" />
        <button class="btn-fail" type="submit">${escapeHtml(t(locale, 'payments.mock.payFail'))}</button>
      </form>
      <form method="post" action="${actionUrl}">
        <input type="hidden" name="action" value="cancel" />
        <button class="btn-cancel" type="submit">${escapeHtml(t(locale, 'payments.mock.cancelBack'))}</button>
      </form>
    </div>
    <div class="dev">
      <h2>${escapeHtml(t(locale, 'payments.mock.devPanelTitle'))}</h2>
      <div class="actions">
        <form method="post" action="${actionUrl}">
          <input type="hidden" name="action" value="duplicate" />
          <button class="btn-dev" type="submit">${escapeHtml(t(locale, 'payments.mock.devDuplicate'))}</button>
        </form>
        <form method="post" action="${actionUrl}">
          <input type="hidden" name="action" value="delayed_3m" />
          <button class="btn-dev" type="submit">${escapeHtml(t(locale, 'payments.mock.devDelayed3m'))}</button>
        </form>
        <form method="post" action="${actionUrl}">
          <input type="hidden" name="action" value="wrong_amount" />
          <button class="btn-dev" type="submit">${escapeHtml(t(locale, 'payments.mock.devWrongAmount'))}</button>
        </form>
        <form method="post" action="${actionUrl}">
          <input type="hidden" name="action" value="refund_auto_succeed" />
          <button class="btn-dev" type="submit">Refund mode: auto_succeed</button>
        </form>
        <form method="post" action="${actionUrl}">
          <input type="hidden" name="action" value="refund_auto_fail" />
          <button class="btn-dev" type="submit">Refund mode: auto_fail</button>
        </form>
        <form method="post" action="${actionUrl}">
          <input type="hidden" name="action" value="refund_delay" />
          <button class="btn-dev" type="submit">Refund mode: delay</button>
        </form>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  buildSignedCallback(payload: {
    readonly eventId: string;
    readonly providerRef: string;
    readonly outcome: PaymentOutcome;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly occurredAt: string;
    readonly timestampSec?: number;
  }): { rawBody: string; headers: Record<string, string> } {
    const secret = this.requireSecret();
    const timestamp = (payload.timestampSec ?? Math.floor(Date.now() / 1000)).toString();
    const rawBody = JSON.stringify({
      eventId: payload.eventId,
      providerRef: payload.providerRef,
      outcome: payload.outcome,
      amountMinor: payload.amountMinor.toString(),
      currency: payload.currency.trim(),
      occurredAt: payload.occurredAt,
    });
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    return {
      rawBody,
      headers: {
        'Content-Type': 'application/json',
        'x-mock-signature': signature,
        'x-mock-timestamp': timestamp,
      },
    };
  }

  async postCallbackToWebhook(
    callbackUrl: string,
    signed: { rawBody: string; headers: Record<string, string> },
  ): Promise<void> {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: signed.headers,
      body: signed.rawBody,
    });
    if (!res.ok) {
      throw new Error(`Mock PSP webhook delivery failed with status ${res.status}`);
    }
  }

  async executeCheckoutAction(
    providerRef: string,
    action: MockPspAction,
    callbackUrl: string,
  ): Promise<{ redirectUrl: string }> {
    const txRow = await this.getTransactionForHostedPage(providerRef);
    const now = new Date();
    const eventId = randomUUID();

    if (action === 'cancel') {
      return { redirectUrl: txRow.returnUrl };
    }

    if (
      action === 'refund_auto_succeed' ||
      action === 'refund_auto_fail' ||
      action === 'refund_delay'
    ) {
      const nextMode: MockPspRefundMode =
        action === 'refund_auto_fail'
          ? 'auto_fail'
          : action === 'refund_delay'
            ? 'delay'
            : 'auto_succeed';
      await this.db
        .update(paymentsMockPspTransactions)
        .set({ refundMode: nextMode, updatedAt: sql`now()` })
        .where(eq(paymentsMockPspTransactions.id, txRow.id));
      return { redirectUrl: `/mock-psp/checkout/${providerRef}` };
    }

    if (action === 'delayed_3m') {
      await this.db
        .update(paymentsMockPspTransactions)
        .set({
          status: 'succeeded',
          lastEventId: eventId,
          occurredAt: now,
          updatedAt: sql`now()`,
        })
        .where(eq(paymentsMockPspTransactions.id, txRow.id));

      if (this.jobQueueService?.isStarted()) {
        await this.jobQueueService.sendJob(
          QUEUE_MOCK_PSP_DELAYED_CALLBACK,
          { providerRef, callbackUrl },
          { startAfter: DELAYED_CALLBACK_SECONDS },
        );
      } else {
        this.logger.warn(
          JSON.stringify({
            level: 'warn',
            event: 'mock_psp_delayed_callback_not_queued_pg_boss_disabled',
            providerRef,
          }),
        );
      }
      return { redirectUrl: txRow.returnUrl };
    }

    const outcome: PaymentOutcome = action === 'fail' ? 'failed' : 'succeeded';
    const callbackAmount = action === 'wrong_amount' ? txRow.amountMinor + 100n : txRow.amountMinor;

    await this.db
      .update(paymentsMockPspTransactions)
      .set({
        status: outcome,
        lastEventId: eventId,
        occurredAt: now,
        updatedAt: sql`now()`,
      })
      .where(eq(paymentsMockPspTransactions.id, txRow.id));

    const signed = this.buildSignedCallback({
      eventId,
      providerRef: txRow.providerRef,
      outcome,
      amountMinor: callbackAmount,
      currency: txRow.currency,
      occurredAt: now.toISOString(),
    });

    await this.postCallbackToWebhook(callbackUrl, signed);
    if (action === 'duplicate') {
      await this.postCallbackToWebhook(callbackUrl, signed);
    }

    return { redirectUrl: txRow.returnUrl };
  }

  async deliverDelayedCallback(payload: Record<string, unknown>): Promise<void> {
    if (resolveAppEnv() === 'production') {
      return;
    }
    if (payload['kind'] === 'refund') {
      const providerRefundRef =
        typeof payload['providerRefundRef'] === 'string' ? payload['providerRefundRef'] : '';
      const callbackUrl = typeof payload['callbackUrl'] === 'string' ? payload['callbackUrl'] : '';
      if (!providerRefundRef || !callbackUrl) {
        return;
      }
      await this.deliverPendingRefundCallback(providerRefundRef, callbackUrl);
      this.logger.log(
        JSON.stringify({
          level: 'info',
          event: 'mock_psp_delayed_refund_callback_delivered',
          providerRefundRef,
        }),
      );
      return;
    }

    const providerRef = typeof payload['providerRef'] === 'string' ? payload['providerRef'] : '';
    const callbackUrl = typeof payload['callbackUrl'] === 'string' ? payload['callbackUrl'] : '';
    if (!providerRef || !callbackUrl) {
      return;
    }
    const [txRow] = await this.db
      .select()
      .from(paymentsMockPspTransactions)
      .where(eq(paymentsMockPspTransactions.providerRef, providerRef))
      .limit(1);
    if (!txRow || txRow.status === 'pending') {
      return;
    }

    const signed = this.buildSignedCallback({
      eventId: txRow.lastEventId ?? randomUUID(),
      providerRef: txRow.providerRef,
      outcome: txRow.status as PaymentOutcome,
      amountMinor: txRow.amountMinor,
      currency: txRow.currency,
      occurredAt: (txRow.occurredAt ?? new Date()).toISOString(),
    });

    await this.postCallbackToWebhook(callbackUrl, signed);
    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'mock_psp_delayed_callback_delivered',
        providerRef,
      }),
    );
  }
}
