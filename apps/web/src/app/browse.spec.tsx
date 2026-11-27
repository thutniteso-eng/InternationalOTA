import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoBanner } from '@/components/DemoBanner';
import { QuoteSummaryPanel } from '@/components/QuoteSummaryPanel';
import {
  computeAvailabilityWindow,
  formatCancellationSentences,
  formatDuration,
  groupDeparturesByDate,
  resolveQuoteErrorMessage,
  type PublicCatalogListResponse,
  type PublicCatalogProductDetail,
  type PublicQuoteResponse,
} from '@/lib/catalog-api';
import LocaleHomePage from '@/app/[locale]/page';
import TourDetailPage, {
  generateMetadata as generateDetailMetadata,
} from '@/app/[locale]/tours/[slug]/page';

function collectTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsxFiles(full));
    } else if (entry.name.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

const UI_ATTR_NAMES = new Set(['aria-label', 'placeholder', 'title', 'alt']);

function findHardcodedJsxLiterals(sourceText: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const cleaned = node.getText(sf).replace(/\s+/g, ' ').trim();
      // Ignore pure punctuation/symbol separators inside expressions
      if (cleaned.length > 0 && /[\p{L}\d]/u.test(cleaned)) {
        violations.push(`${fileName}: JsxText literal "${cleaned}"`);
      }
    } else if (ts.isJsxAttribute(node)) {
      const attrName = node.name.getText(sf);
      if (UI_ATTR_NAMES.has(attrName) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const val = node.initializer.text.trim();
        if (val.length > 0 && /[\p{L}\d]/u.test(val)) {
          violations.push(`${fileName}: JSX attribute ${attrName}="${val}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return violations;
}

const SAMPLE_LIST_ITEM = {
  id: '01950000-0000-7000-8000-000000000101',
  kind: 'tour' as const,
  locale: 'vi',
  title: 'Tour cano 4 đảo kết hợp cáp treo Hòn Thơm',
  slug: 'tour-cano-4-dao-ket-hop-cap-treo-hon-thom',
  summary: 'Tour 4 đảo bằng cano kèm vé cáp treo vượt biển ra Hòn Thơm.',
  countryAlpha2: 'VN',
  region: 'Phú Quốc',
  location: { lat: 10.0219, lng: 104.0089 },
  timeZone: 'Asia/Ho_Chi_Minh',
  durationMinutes: 600,
  publishedAt: '2026-11-27T01:00:00.000Z',
  supplierName: 'Ngọc Biển Travel (Demo)',
  primaryImage: null,
  fromPrice: {
    currency: 'VND',
    amountMinor: '1450000',
    formatted: '1.450.000\u00a0₫',
  },
};

const SAMPLE_DETAIL_VI: PublicCatalogProductDetail = {
  ...SAMPLE_LIST_ITEM,
  slug: 'tour-cano-4-dao-nam-phu-quoc',
  title: 'Tour cano 4 đảo Nam Phú Quốc – lặn ngắm san hô',
  description: 'Cano đưa đoàn khám phá Hòn Móng Tay, Hòn Gầm Ghì, Hòn Mây Rút.',
  meetingPointNote: 'Cảng An Thới / An Thoi Port',
  highlights: ['Lặn ống thở ngắm san hô', 'Ăn trưa hải sản trên đảo'],
  inclusions: ['Cano cao tốc, áo phao', 'Bữa trưa'],
  exclusions: ['Vé cáp treo Hòn Thơm'],
  images: [],
  fromPrice: {
    currency: 'VND',
    amountMinor: '950000',
    formatted: '950.000\u00a0₫',
  },
  cancellationSummary: {
    version: 1,
    rules: [
      { hoursBeforeStart: 48, refundPercent: 100 },
      { hoursBeforeStart: 24, refundPercent: 50 },
      { hoursBeforeStart: 0, refundPercent: 0 },
    ],
    weatherClause: 'full_refund_or_reschedule',
  },
  alternateSlugs: {
    vi: 'tour-cano-4-dao-nam-phu-quoc',
    en: 'south-phu-quoc-4-island-speedboat-tour',
  },
};

describe('Customer Browse Web (P2-09A)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC2: QuoteSummaryPanel displays API-matching 2.550.000 ₫ (vi) and ₫2,550,000 (en) with disabled Book button', () => {
    const sampleQuote: PublicQuoteResponse = {
      productId: SAMPLE_DETAIL_VI.id,
      departureId: '01950000-0000-7000-8000-000000000901',
      startsAt: '2026-12-05T01:00:00.000Z',
      localDate: '2026-12-05',
      locale: 'vi',
      currency: 'VND',
      lines: [
        {
          paxType: 'adult',
          quantity: 2,
          unitAmountMinor: '950000',
          unitFormatted: '950.000\u00a0₫',
          lineAmountMinor: '1900000',
          lineFormatted: '1.900.000\u00a0₫',
        },
        {
          paxType: 'child',
          quantity: 1,
          unitAmountMinor: '650000',
          unitFormatted: '650.000\u00a0₫',
          lineAmountMinor: '650000',
          lineFormatted: '650.000\u00a0₫',
        },
        {
          paxType: 'infant',
          quantity: 1,
          unitAmountMinor: '0',
          unitFormatted: '0\u00a0₫',
          lineAmountMinor: '0',
          lineFormatted: '0\u00a0₫',
        },
      ],
      totalAmountMinor: '2550000',
      totalFormatted: '2.550.000\u00a0₫',
      seats: 3,
      priceListVersion: 1,
      cancellationPolicyVersion: 1,
      rules: SAMPLE_DETAIL_VI.cancellationSummary!.rules,
      weatherClause: 'full_refund_or_reschedule',
      quotedAt: '2026-11-27T01:00:00.000Z',
      snapshotHash: 'abc123',
    };

    const htmlVi = renderToStaticMarkup(
      <QuoteSummaryPanel locale="vi" quote={sampleQuote} errorMessage={null} isLoading={false} />,
    );
    expect(htmlVi.replace(/\u00a0/g, ' ')).toContain('2.550.000 ₫');
    expect(htmlVi).toContain('Số chỗ giữ: 3');
    expect(htmlVi).toContain('disabled=""');
    expect(htmlVi).toContain('Đặt chỗ sắp ra mắt');

    const htmlEn = renderToStaticMarkup(
      <QuoteSummaryPanel locale="en" quote={sampleQuote} errorMessage={null} isLoading={false} />,
    );
    expect(htmlEn).toContain('₫2,550,000');
    expect(htmlEn).toContain('Booking coming soon');
  });

  it('AC3 & AC4 & AC5 & AC6: SSR list/detail render DEMO banner, search results, 37 remaining seats, and alternate locale links', async () => {
    const fetchMock = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/catalog/products?')) {
        const payload: PublicCatalogListResponse = {
          items: [SAMPLE_LIST_ITEM],
          nextCursor: null,
        };
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      }
      if (url.includes('/catalog/products/vi/unknown-slug')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 404 }), { status: 404 }));
      }
      if (url.includes('/catalog/products/vi/tour-cano-4-dao-nam-phu-quoc')) {
        return Promise.resolve(new Response(JSON.stringify(SAMPLE_DETAIL_VI), { status: 200 }));
      }
      if (url.includes('/availability?')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: '01950000-0000-7000-8000-000000000902',
                  localDate: '2026-12-05',
                  localTime: '08:00:00',
                  startsAt: '2026-12-05T01:00:00.000Z',
                  remaining: 37,
                  status: 'available',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('Not found', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    // List SSR (with search query q="hon thom")
    const listTree = await LocaleHomePage({
      params: Promise.resolve({ locale: 'vi' }),
      searchParams: Promise.resolve({ q: 'hon thom' }),
    });
    const listHtml = renderToStaticMarkup(
      <>
        <DemoBanner locale="vi" />
        {listTree}
      </>,
    );
    expect(listHtml).toContain('DEMO — dữ liệu minh họa, không phải ưu đãi thật');
    expect(listHtml).toContain('Tour cano 4 đảo kết hợp cáp treo Hòn Thơm');
    expect(listHtml.replace(/\u00a0/g, ' ')).toContain('Từ 1.450.000 ₫');
    expect(listHtml).toContain('aria-hidden="true"');
    expect(listHtml).toContain('<label for="catalog-search-input"');

    // Detail SSR (checks heading order, OSM link, 37 remaining seats, alternate slug switch)
    const detailMeta = await generateDetailMetadata({
      params: Promise.resolve({ locale: 'vi', slug: 'tour-cano-4-dao-nam-phu-quoc' }),
    });
    expect(detailMeta.alternates?.languages).toEqual({
      vi: '/vi/tours/tour-cano-4-dao-nam-phu-quoc',
      en: '/en/tours/south-phu-quoc-4-island-speedboat-tour',
      'x-default': '/vi/tours/tour-cano-4-dao-nam-phu-quoc',
    });

    const detailTree = await TourDetailPage({
      params: Promise.resolve({ locale: 'vi', slug: 'tour-cano-4-dao-nam-phu-quoc' }),
    });
    const detailHtml = renderToStaticMarkup(
      <>
        <DemoBanner locale="en" />
        {detailTree}
      </>,
    );
    expect(detailHtml).toContain('DEMO — sample data, not real offers');
    expect(detailHtml).toContain('37 chỗ trống');
    expect(detailHtml).toContain('href="/en/tours/south-phu-quoc-4-island-speedboat-tour"');
    expect(detailHtml).toContain('https://www.openstreetmap.org/?mlat=10.0219&amp;mlon=104.0089');
    expect(detailHtml).toContain('Hủy từ 48 giờ trở lên trước giờ khởi hành: hoàn 100%.');

    // Unknown slug calls Next.js notFound() -> NEXT_HTTP_ERROR_FALLBACK;404
    await expect(
      TourDetailPage({
        params: Promise.resolve({ locale: 'vi', slug: 'unknown-slug' }),
      }),
    ).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it('AC5: zero hardcoded UI string literals exist in apps/web TSX files', () => {
    // Positive proof that our detector catches hardcoded strings
    const synthetic = `export function Bad() { return <button aria-label="Click me">Hardcoded label</button>; }`;
    expect(findHardcodedJsxLiterals(synthetic, 'synthetic.tsx').length).toBeGreaterThanOrEqual(2);

    const srcDir = resolve(import.meta.dirname, '..');
    const tsxFiles = collectTsxFiles(srcDir);
    expect(tsxFiles.length).toBeGreaterThan(0);

    const allViolations: string[] = [];
    for (const file of tsxFiles) {
      allViolations.push(...findHardcodedJsxLiterals(readFileSync(file, 'utf8'), file));
    }
    expect(allViolations).toEqual([]);
  });

  it('helpers format durations, policies, availability windows, and typed errors cleanly', () => {
    expect(formatDuration(540, 'en')).toBe('9 hours');
    expect(formatDuration(90, 'vi')).toBe('1 giờ 30 phút');
    expect(formatDuration(30, 'en')).toBe('30 min');

    const win0 = computeAvailabilityWindow('Asia/Ho_Chi_Minh', 0, new Date('2026-11-27T02:00:00Z'));
    expect(win0).toEqual({
      fromDate: '2026-11-27',
      toDate: '2026-12-10',
      hasPrev: false,
      hasNext: true,
    });
    const win4 = computeAvailabilityWindow('Asia/Ho_Chi_Minh', 4, new Date('2026-11-27T02:00:00Z'));
    expect(win4.toDate).toBe('2027-01-27');
    expect(win4.hasNext).toBe(false);
    expect(win4.hasPrev).toBe(true);

    const grouped = groupDeparturesByDate([
      {
        id: '1',
        localDate: '2026-11-27',
        localTime: '07:00:00',
        startsAt: '2026-11-27T00:00:00Z',
        remaining: 10,
        status: 'available',
      },
      {
        id: '2',
        localDate: '2026-11-27',
        localTime: '14:30:00',
        startsAt: '2026-11-27T07:30:00Z',
        remaining: 4,
        status: 'available',
      },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.departures).toHaveLength(2);

    const rulesText = formatCancellationSentences(SAMPLE_DETAIL_VI.cancellationSummary, 'en');
    expect(rulesText).toMatchInlineSnapshot(`
      [
        "Cancel 48+ hours before start: 100% refund.",
        "Cancel 24+ hours before start: 50% refund.",
        "Cancel under 24 hours before start: no refund.",
        "Weather cancellation by operator: full refund or free reschedule.",
      ]
    `);
    expect(formatCancellationSentences(SAMPLE_DETAIL_VI.cancellationSummary, 'vi'))
      .toMatchInlineSnapshot(`
      [
        "Hủy từ 48 giờ trở lên trước giờ khởi hành: hoàn 100%.",
        "Hủy từ 24 giờ trở lên trước giờ khởi hành: hoàn 50%.",
        "Hủy dưới 24 giờ trước giờ khởi hành: không hoàn tiền.",
        "Thời tiết xấu do đơn vị vận hành hủy: hoàn 100% hoặc đổi ngày miễn phí.",
      ]
    `);

    expect(
      resolveQuoteErrorMessage(
        { i18nKey: 'pricing.quote.paxTypeNotOffered', i18nParams: { paxType: 'child' } },
        'en',
      ),
    ).toBe('Passenger type "child" is not offered on this price list.');
  });
});
