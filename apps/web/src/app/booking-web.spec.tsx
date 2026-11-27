import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthForm } from '@/components/AuthForm';
import { CancelConfirmPanel } from '@/components/CancelConfirmPanel';
import { PriceChangedPanel } from '@/components/PriceChangedPanel';
import { fetchReturnBookingDetail, ReturnStatusView } from '@/components/ReturnStatusClient';
import { TourAvailabilityQuote } from '@/components/TourAvailabilityQuote';
import { VerifyEmailBanner } from '@/components/VerifyEmailBanner';
import { sanitizeReturnTo } from '@/lib/auth-client';
import {
  applyPaxDelta,
  buildAvailabilityDateStrip,
  classifyHoldError,
  formatCancelPreviewMessage,
  formatPaxStepperLabel,
  MAX_PAX_TOTAL,
  resolveReturnViewState,
  type BookingDetailDto,
  type PublicPaxAgeBandDto,
} from '@/lib/booking-api';
import type { PublicQuoteResponse } from '@/lib/catalog-api';

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      if (!entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.spec.tsx')) {
        results.push(full);
      }
    }
  }
  return results;
}

const SAMPLE_AGE_BANDS: readonly PublicPaxAgeBandDto[] = [
  { paxType: 'adult', minAge: 10, maxAge: null, occupiesSeat: true },
  { paxType: 'child', minAge: 5, maxAge: 9, occupiesSeat: true },
  { paxType: 'infant', minAge: 0, maxAge: 4, occupiesSeat: false },
];

const SAMPLE_QUOTE_OLD: PublicQuoteResponse = {
  productId: '01950000-0000-7000-8000-000000000101',
  departureId: '01950000-0000-7000-8000-000000000901',
  startsAt: '2026-12-05T01:00:00.000Z',
  localDate: '2026-12-05',
  locale: 'en',
  currency: 'VND',
  lines: [
    {
      paxType: 'adult',
      quantity: 1,
      unitAmountMinor: '950000',
      unitFormatted: '₫950,000',
      lineAmountMinor: '950000',
      lineFormatted: '₫950,000',
    },
  ],
  totalAmountMinor: '950000',
  totalFormatted: '₫950,000',
  seats: 1,
  priceListVersion: 1,
  cancellationPolicyVersion: 1,
  rules: [
    { hoursBeforeStart: 48, refundPercent: 100 },
    { hoursBeforeStart: 24, refundPercent: 50 },
    { hoursBeforeStart: 0, refundPercent: 0 },
  ],
  weatherClause: 'full_refund_or_reschedule',
  quotedAt: '2026-11-27T01:00:00.000Z',
  snapshotHash: 'old-hash-111',
};

const SAMPLE_QUOTE_NEW: PublicQuoteResponse = {
  ...SAMPLE_QUOTE_OLD,
  lines: [
    {
      paxType: 'adult',
      quantity: 1,
      unitAmountMinor: '1150000',
      unitFormatted: '₫1,150,000',
      lineAmountMinor: '1150000',
      lineFormatted: '₫1,150,000',
    },
  ],
  totalAmountMinor: '1150000',
  totalFormatted: '₫1,150,000',
  priceListVersion: 2,
  snapshotHash: 'new-hash-222',
};

function makeSampleBooking(
  status: BookingDetailDto['status'],
  payment?: BookingDetailDto['payment'],
): BookingDetailDto {
  return {
    id: '01950000-0000-7000-8000-00000000b001',
    reference: 'PQ-DEMO1234',
    customerUserId: 'user-1',
    productId: SAMPLE_QUOTE_OLD.productId,
    departureId: SAMPLE_QUOTE_OLD.departureId,
    status,
    pax: { adult: 1, child: 0, infant: 0 },
    seats: 1,
    currency: 'VND',
    totalAmountMinor: '1000000',
    quoteSnapshot: {
      productId: SAMPLE_QUOTE_OLD.productId,
      departureId: SAMPLE_QUOTE_OLD.departureId,
      startsAt: SAMPLE_QUOTE_OLD.startsAt,
      localDate: SAMPLE_QUOTE_OLD.localDate,
      currency: 'VND',
      lines: [
        {
          paxType: 'adult',
          quantity: 1,
          unitAmountMinor: '1000000',
          lineAmountMinor: '1000000',
        },
      ],
      totalAmountMinor: '1000000',
      seats: 1,
      priceListVersion: 1,
      cancellationPolicyVersion: 1,
      rules: SAMPLE_QUOTE_OLD.rules,
      weatherClause: 'full_refund_or_reschedule',
    },
    snapshotHash: 'hash-1',
    contactName: 'Nguyen Van A',
    contactEmail: 'a@example.com',
    contactPhone: '+84901234567',
    contactLocale: 'vi',
    holdExpiresAt: '2026-11-27T02:00:00.000Z',
    paymentRef: status === 'confirmed' ? 'mock_pay_1' : null,
    version: 1,
    confirmedAt: status === 'confirmed' ? '2026-11-27T01:45:00.000Z' : null,
    expiredAt: null,
    cancelledAt: null,
    createdAt: '2026-11-27T01:40:00.000Z',
    updatedAt: '2026-11-27T01:45:00.000Z',
    ...(payment ? { payment } : {}),
  };
}

describe('Customer Booking Web (P2-09)', () => {
  it('AC2: pax steppers enforce >= 1 adult and <= 50 total, and display age bands (U2)', () => {
    let pax = { adult: 1, child: 0, infant: 0 };
    // Cannot decrement adult below 1
    pax = applyPaxDelta(pax, 'adult', -1);
    expect(pax.adult).toBe(1);
    // Cannot decrement child below 0
    pax = applyPaxDelta(pax, 'child', -1);
    expect(pax.child).toBe(0);

    // Increase up to MAX_PAX_TOTAL (50), capped strictly at 50
    pax = { adult: 30, child: 19, infant: 1 };
    const overCap = applyPaxDelta(pax, 'infant', 1);
    expect(overCap.adult + overCap.child + overCap.infant).toBe(MAX_PAX_TOTAL);
    expect(overCap.infant).toBe(1);

    expect(formatPaxStepperLabel('adult', 'vi', SAMPLE_AGE_BANDS)).toBe('Người lớn (từ 10 tuổi)');
    expect(formatPaxStepperLabel('child', 'vi', SAMPLE_AGE_BANDS)).toBe('Trẻ em (5–9 tuổi)');
    expect(formatPaxStepperLabel('infant', 'vi', SAMPLE_AGE_BANDS)).toBe('Em bé (0–4 tuổi)');
    expect(formatPaxStepperLabel('adult', 'en', SAMPLE_AGE_BANDS)).toBe('Adult (10+ yrs)');
    expect(formatPaxStepperLabel('child', 'en', SAMPLE_AGE_BANDS)).toBe('Child (5–9 yrs)');
  });

  it('AC2 & U3 & U4: date strip builds 14 horizontal days and disables Previous on first window', () => {
    const strip = buildAvailabilityDateStrip('2026-11-28', [
      {
        id: 'dep-1',
        localDate: '2026-12-01',
        localTime: '08:00:00',
        startsAt: '2026-12-01T01:00:00.000Z',
        remaining: 12,
        status: 'available',
      },
    ]);
    expect(strip).toHaveLength(14);
    expect(strip[0]!.localDate).toBe('2026-11-28');
    expect(strip[13]!.localDate).toBe('2026-12-11');
    expect(strip[3]!.openCount).toBe(1);

    const html = renderToStaticMarkup(
      <TourAvailabilityQuote
        productId={SAMPLE_QUOTE_OLD.productId}
        productSlug="tour-cano-4-dao"
        locale="vi"
        timeZone="Asia/Ho_Chi_Minh"
        initialFromDate="2026-11-28"
        initialToDate="2026-12-11"
        initialHasNext
        initialAgeBands={SAMPLE_AGE_BANDS}
        initialDepartures={[
          {
            id: 'dep-1',
            localDate: '2026-12-01',
            localTime: '08:00:00',
            startsAt: '2026-12-01T01:00:00.000Z',
            remaining: 12,
            status: 'available',
          },
        ]}
      />,
    );
    expect(html).toContain('Trẻ em (5–9 tuổi)');
    expect(html).toContain('Người lớn (từ 10 tuổi)');
    expect(html).toContain('class="dateStrip"');
    expect(html).toMatch(/data-testid="window-prev-btn"[^>]*disabled=""/);
  });

  it('AC2: price_changed dialog renders old vs new total and explicit Accept new price action', () => {
    const outcome = classifyHoldError(
      409,
      {
        code: 'price_changed',
        i18nKey: 'price_changed',
        detail: 'Tour price or policy changed since your quote; please review the updated quote.',
        quote: SAMPLE_QUOTE_NEW,
      },
      'en',
    );
    expect(outcome.kind).toBe('price_changed');

    const soldOutOutcome = classifyHoldError(409, { code: 'sold_out', i18nKey: 'sold_out' }, 'vi');
    expect(soldOutOutcome.kind).toBe('unavailable');
    if (soldOutOutcome.kind === 'unavailable') {
      expect(soldOutOutcome.message).toBe('Lịch khởi hành không còn đủ chỗ trống.');
    }

    const htmlEn = renderToStaticMarkup(
      <PriceChangedPanel
        locale="en"
        previousQuote={SAMPLE_QUOTE_OLD}
        updatedQuote={SAMPLE_QUOTE_NEW}
        onAcceptNewPrice={() => {}}
      />,
    );
    expect(htmlEn).toContain('role="alertdialog"');
    expect(htmlEn).toContain('Price or policy updated');
    expect(htmlEn).toContain('₫950,000');
    expect(htmlEn).toContain('₫1,150,000');
    expect(htmlEn).toContain('Accept new price');
  });

  it('AC2 & AC3: return page trusts only API status and ignores client query assumptions', () => {
    const pendingBooking = makeSampleBooking('payment_pending', {
      status: 'pending',
      attemptCount: 1,
    });
    expect(resolveReturnViewState(pendingBooking, false)).toEqual({
      kind: 'processing',
      canRetry: false,
    });
    expect(resolveReturnViewState(pendingBooking, true)).toEqual({
      kind: 'timed_out',
      canRetry: false,
    });

    const htmlProcessing = renderToStaticMarkup(
      <ReturnStatusView
        locale="vi"
        reference={pendingBooking.reference}
        booking={pendingBooking}
        timedOut={false}
      />,
    );
    expect(htmlProcessing).toContain('Đang xử lý');
    expect(htmlProcessing).not.toContain('Đã xác nhận');

    const failedHold = makeSampleBooking('held', { status: 'failed', attemptCount: 1 });
    expect(resolveReturnViewState(failedHold, false)).toEqual({
      kind: 'failed',
      canRetry: true,
    });

    const confirmedBooking = makeSampleBooking('confirmed', {
      status: 'succeeded',
      attemptCount: 1,
    });
    expect(resolveReturnViewState(confirmedBooking, false)).toEqual({
      kind: 'confirmed',
      canRetry: false,
    });

    const htmlConfirmed = renderToStaticMarkup(
      <ReturnStatusView
        locale="vi"
        reference={confirmedBooking.reference}
        booking={confirmedBooking}
        timedOut={false}
      />,
    );
    expect(htmlConfirmed).toContain('Đã xác nhận');
    expect(htmlConfirmed).toContain('PQ-DEMO1234');
  });

  it('AC2: returnTo sanitizer accepts relative same-origin paths and rejects external URLs', () => {
    expect(sanitizeReturnTo('/vi/tours/hon-thom?adult=2', 'vi')).toBe('/vi/tours/hon-thom?adult=2');
    expect(sanitizeReturnTo('/en/book/123', 'vi')).toBe('/en/book/123');
    expect(sanitizeReturnTo('https://evil.example/steal', 'vi')).toBe('/vi');
    expect(sanitizeReturnTo('http://localhost:9999/bad', 'en')).toBe('/en');
    expect(sanitizeReturnTo('//evil.example/phish', 'en')).toBe('/en');
    expect(sanitizeReturnTo('/\\evil.example', 'vi')).toBe('/vi');
    expect(sanitizeReturnTo('javascript:alert(1)', 'vi')).toBe('/vi');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC2 & AC3: return poll uses mocked fetch and shows Confirmed only after server returns confirmed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            makeSampleBooking('payment_pending', { status: 'pending', attemptCount: 1 }),
          ),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makeSampleBooking('confirmed', { status: 'succeeded', attemptCount: 1 })),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    // Poll 1: payment_pending -> never shows Confirmed even if query has ?status=success
    const step1 = await fetchReturnBookingDetail('PQ-DEMO1234', fetchMock);
    expect(step1.kind).toBe('ok');
    if (step1.kind === 'ok') {
      const state1 = resolveReturnViewState(step1.booking, false);
      expect(state1.kind).toBe('processing');
      const html1 = renderToStaticMarkup(
        <ReturnStatusView
          locale="vi"
          reference="PQ-DEMO1234"
          booking={step1.booking}
          timedOut={false}
        />,
      );
      expect(html1).toContain('Đang xử lý');
      expect(html1).not.toContain('Đã xác nhận');
    }

    // Poll 2: server confirmed -> shows Confirmed
    const step2 = await fetchReturnBookingDetail('PQ-DEMO1234', fetchMock);
    expect(step2.kind).toBe('ok');
    if (step2.kind === 'ok') {
      const state2 = resolveReturnViewState(step2.booking, false);
      expect(state2.kind).toBe('confirmed');
      const html2 = renderToStaticMarkup(
        <ReturnStatusView
          locale="vi"
          reference="PQ-DEMO1234"
          booking={step2.booking}
          timedOut={false}
        />,
      );
      expect(html2).toContain('Đã xác nhận');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('AC2: cancel preview panel formats exact refund amounts in vi and en without window.alert/confirm', () => {
    const preview = {
      status: 'confirmed',
      currency: 'VND',
      totalAmountMinor: '1000000',
      refundAmountMinor: '500000',
      refundPercent: 50,
      ruleApplied: { hoursBeforeStart: 24, refundPercent: 50 },
      cancellable: true,
    };

    expect(formatCancelPreviewMessage(preview, 'vi').replace(/\u00a0/g, ' ')).toBe(
      'Bạn sẽ được hoàn 500.000 ₫ (50%).',
    );
    expect(formatCancelPreviewMessage(preview, 'en').replace(/\u00a0/g, ' ')).toBe(
      'You will receive a refund of ₫500,000 (50%).',
    );

    const htmlVi = renderToStaticMarkup(
      <CancelConfirmPanel
        locale="vi"
        preview={preview}
        loadingPreview={false}
        submitting={false}
        errorMessage={null}
        onConfirm={() => {}}
        onKeep={() => {}}
      />,
    );
    expect(htmlVi.replace(/\u00a0/g, ' ')).toContain('Bạn sẽ được hoàn 500.000 ₫ (50%).');

    const srcDir = resolve(import.meta.dirname, '..');
    for (const file of collectTsFiles(srcDir)) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/\bwindow\.(alert|confirm)\b/);
    }
  });

  it('AC4: auth & banner forms render accessible labels, headings, and live regions', () => {
    const authHtml = renderToStaticMarkup(<AuthForm locale="vi" mode="sign-up" />);
    expect(authHtml).toContain('<h1 class="pageTitle">');
    expect(authHtml).toContain('for="auth-name"');
    expect(authHtml).toContain('for="auth-email"');
    expect(authHtml).toContain('for="auth-password"');

    const bannerHtml = renderToStaticMarkup(
      <VerifyEmailBanner locale="en" email="guest@example.com" />,
    );
    expect(bannerHtml).toContain('aria-live="polite"');
    expect(bannerHtml).toContain('Resend verification email');
  });
});
