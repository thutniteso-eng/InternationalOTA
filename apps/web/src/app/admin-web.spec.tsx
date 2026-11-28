import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminBookingDetailView } from '@/components/admin/AdminBookingDetailClient';
import { AdminDashboardView } from '@/components/admin/AdminDashboardClient';
import {
  canSubmitDepartureConfirm,
  DepartureConfirmPanelView,
} from '@/components/admin/AdminDeparturesClient';
import type { AdminBookingDetailDto, AdminDashboardDto } from '@/lib/admin-api';

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

const SAMPLE_DASHBOARD: AdminDashboardDto = {
  today: {
    byStatus: { held: 1, payment_pending: 0, confirmed: 2, cancelled: 0, expired: 0 },
    totalBookings: 3,
    confirmedRevenueByCurrency: [{ currency: 'VND', totalAmountMinor: '1900000' }],
  },
  last7Days: {
    byStatus: { held: 2, payment_pending: 1, confirmed: 5, cancelled: 1, expired: 2 },
    totalBookings: 11,
    confirmedRevenueByCurrency: [{ currency: 'VND', totalAmountMinor: '4850000' }],
  },
  latestReconciliation: {
    id: '01950000-0000-7000-8000-000000000777',
    startedAt: '2026-11-28T01:00:00.000Z',
    finishedAt: '2026-11-28T01:00:02.000Z',
    asOf: '2026-11-28T01:00:00.000Z',
    status: 'ok',
    counts: { errors: 0, warnings: 0, checks: 6, totalFindings: 0 },
    triggeredBy: 'cron',
  },
  pendingRefundsCount: 1,
};

const SAMPLE_BOOKING_DETAIL: AdminBookingDetailDto = {
  id: '01950000-0000-7000-8000-000000000888',
  reference: 'PQ-ADMINDET',
  customerUserId: 'cust-1',
  productId: 'prod-1',
  departureId: 'dep-1',
  status: 'cancelled',
  pax: { adult: 2, child: 0, infant: 0 },
  seats: 2,
  currency: 'VND',
  totalAmountMinor: '1900000',
  quoteSnapshot: {
    productId: 'prod-1',
    departureId: 'dep-1',
    startsAt: '2026-12-05T02:00:00.000Z',
    localDate: '2026-12-05',
    currency: 'VND',
    lines: [],
    totalAmountMinor: '1900000',
    seats: 2,
    priceListVersion: 1,
    cancellationPolicyVersion: 1,
    rules: [],
    weatherClause: null,
  },
  snapshotHash: 'hash',
  contactName: 'Nguyen Van A',
  contactEmail: 'vana@example.com',
  contactPhone: '+84901234567',
  contactLocale: 'vi',
  holdExpiresAt: '2026-11-28T01:15:00.000Z',
  paymentRef: 'mock-ref-123',
  version: 3,
  confirmedAt: '2026-11-28T01:05:00.000Z',
  expiredAt: null,
  cancelledAt: '2026-11-28T01:10:00.000Z',
  createdAt: '2026-11-28T01:00:00.000Z',
  updatedAt: '2026-11-28T01:10:00.000Z',
  events: [
    {
      id: 'ev-1',
      fromStatus: null,
      toStatus: 'held',
      actor: 'customer:cust-1',
      reason: 'hold_created',
      at: '2026-11-28T01:00:00.000Z',
    },
    {
      id: 'ev-2',
      fromStatus: 'confirmed',
      toStatus: 'cancelled',
      actor: 'customer:cust-1',
      reason: 'customer_cancellation',
      at: '2026-11-28T01:10:00.000Z',
    },
  ],
  attempts: [
    {
      id: 'att-1',
      provider: 'mock',
      providerRef: 'mock-ref-123',
      amountMinor: '1900000',
      currency: 'VND',
      status: 'succeeded',
      failureReason: null,
      createdAt: '2026-11-28T01:01:00.000Z',
      completedAt: '2026-11-28T01:05:00.000Z',
    },
  ],
  refunds: [
    {
      id: 'ref-1',
      paymentAttemptId: 'att-1',
      provider: 'mock',
      amountMinor: '1900000',
      currency: 'VND',
      reason: 'customer_cancellation',
      status: 'manual_review',
      providerRefundRef: null,
      attempts: 3,
      lastError: 'PSP timeout',
      createdAt: '2026-11-28T01:10:00.000Z',
      updatedAt: '2026-11-28T01:12:00.000Z',
      completedAt: null,
    },
  ],
  emails: [
    {
      id: 'em-1',
      template: 'booking_confirmed',
      locale: 'vi',
      status: 'sent',
      attempts: 1,
      lastError: null,
      sentAt: '2026-11-28T01:05:10.000Z',
      createdAt: '2026-11-28T01:05:01.000Z',
    },
  ],
};

describe('Admin console UI (P2-10 AC9)', () => {
  it('renders dashboard figures formatted for both vi and en', () => {
    const htmlVi = renderToStaticMarkup(
      <AdminDashboardView locale="vi" data={SAMPLE_DASHBOARD} />,
    ).replace(/\u00a0/g, ' ');
    expect(htmlVi).toContain('1.900.000 ₫');
    expect(htmlVi).toContain('4.850.000 ₫');
    expect(htmlVi).toContain('08:00');
    expect(htmlVi).not.toContain('08:00:00');
    expect(htmlVi).toContain('/vi/admin/reconciliation/01950000-0000-7000-8000-000000000777');

    const htmlEn = renderToStaticMarkup(
      <AdminDashboardView locale="en" data={SAMPLE_DASHBOARD} />,
    ).replace(/\u00a0/g, ' ');
    expect(htmlEn).toContain('₫1,900,000');
    expect(htmlEn).toContain('₫4,850,000');
    expect(htmlEn).toContain('0 errors · 0 warnings');
  });

  it('cancel-departure confirmation panel requires a reason and shows affected bookings count', () => {
    expect(canSubmitDepartureConfirm('cancel', '')).toBe(false);
    expect(canSubmitDepartureConfirm('cancel', '   ')).toBe(false);
    expect(canSubmitDepartureConfirm('cancel', 'Storm warning')).toBe(true);
    expect(canSubmitDepartureConfirm('close', '')).toBe(true);

    const html = renderToStaticMarkup(
      <DepartureConfirmPanelView
        locale="en"
        departureId="dep-1"
        mode="cancel"
        loadingSummary={false}
        cancelSummary={{
          departureId: 'dep-1',
          departureStatus: 'open',
          bookings: {
            total: 5,
            confirmed: 3,
            cancelled: 0,
            held: 1,
            paymentPending: 1,
            expired: 0,
          },
          refunds: {
            total: 0,
            requested: 0,
            processing: 0,
            succeeded: 0,
            failed: 0,
            manualReview: 0,
          },
        }}
        actionReason=""
        actionError={null}
        submitting={false}
        onReasonChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('3 confirmed');
    expect(html).toContain('2 active holds');
    expect(html).toContain('disabled=""');
  });

  it('booking detail displays admin contact PII, status history, attempts, refunds & email metadata', () => {
    const html = renderToStaticMarkup(
      <AdminBookingDetailView locale="vi" booking={SAMPLE_BOOKING_DETAIL} />,
    ).replace(/\u00a0/g, ' ');

    expect(html).toContain('PQ-ADMINDET');
    expect(html).toContain('vana@example.com');
    expect(html).toContain('+84901234567');
    expect(html).toContain('hold_created');
    expect(html).toContain('customer_cancellation');
    expect(html).toContain('manual_review');
    expect(html).toContain('PSP timeout');
    expect(html).toContain('booking_confirmed');
    expect(html).not.toContain('Từ chối đơn');

    const confirmedHtmlVi = renderToStaticMarkup(
      <AdminBookingDetailView
        locale="vi"
        booking={{ ...SAMPLE_BOOKING_DETAIL, status: 'confirmed', cancelledAt: null }}
      />,
    );
    expect(confirmedHtmlVi).toContain('Từ chối đơn');

    const confirmedHtmlEn = renderToStaticMarkup(
      <AdminBookingDetailView
        locale="en"
        booking={{ ...SAMPLE_BOOKING_DETAIL, status: 'confirmed', cancelledAt: null }}
      />,
    );
    expect(confirmedHtmlEn).toContain('Reject booking');
  });

  it('uses zero window.alert / window.confirm calls across apps/web/src', () => {
    const srcDir = resolve(import.meta.dirname, '..');
    for (const file of collectTsFiles(srcDir)) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/\b(window\.)?(alert|confirm)\s*\(/);
    }
  });
});
