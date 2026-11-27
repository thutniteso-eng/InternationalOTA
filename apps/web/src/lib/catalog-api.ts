import { formatCancellationPolicySentences, t, type BuiltinLocale } from '@internationalota/i18n';
import { addDays, toLocalDateTime } from '@internationalota/time';

export type ProductKind = 'tour' | 'activity' | 'transfer';
export type PaxType = 'adult' | 'child' | 'infant';

export interface PublicFromPriceDto {
  readonly currency: string;
  readonly amountMinor: string;
  readonly formatted: string;
}

export interface CancellationRule {
  readonly hoursBeforeStart: number;
  readonly refundPercent: number;
}

export interface PublicCancellationSummaryDto {
  readonly version: number;
  readonly rules: readonly CancellationRule[];
  readonly weatherClause: string | null;
}

export interface PublicCatalogProductSummary {
  readonly id: string;
  readonly kind: ProductKind;
  readonly locale: string;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly countryAlpha2: string;
  readonly region: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly timeZone: string;
  readonly durationMinutes: number | null;
  readonly publishedAt: string;
  readonly supplierName: string;
  readonly primaryImage: {
    readonly url: string;
    readonly sort: number;
    readonly alt: string | null;
  } | null;
  readonly fromPrice: PublicFromPriceDto | null;
  readonly distanceMeters?: number;
}

export interface PublicCatalogProductDetail extends PublicCatalogProductSummary {
  readonly description: string;
  readonly meetingPointNote: string | null;
  readonly highlights: readonly string[];
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly images: readonly {
    readonly url: string;
    readonly sort: number;
    readonly alt: string | null;
  }[];
  readonly cancellationSummary: PublicCancellationSummaryDto | null;
  readonly alternateSlugs: Readonly<Record<string, string>>;
}

export interface PublicCatalogListResponse {
  readonly items: readonly PublicCatalogProductSummary[];
  readonly nextCursor: string | null;
}

export interface PublicAvailabilityItem {
  readonly id: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly startsAt: string;
  readonly remaining: number;
  readonly status: 'available' | 'sold_out';
}

export interface PublicAvailabilityResponse {
  readonly items: readonly PublicAvailabilityItem[];
}

export interface PublicQuoteLineDto {
  readonly paxType: PaxType;
  readonly quantity: number;
  readonly unitAmountMinor: string;
  readonly unitFormatted: string;
  readonly lineAmountMinor: string;
  readonly lineFormatted: string;
}

export interface PublicQuoteResponse {
  readonly productId: string;
  readonly departureId: string;
  readonly startsAt: string;
  readonly localDate: string;
  readonly locale: string;
  readonly currency: string;
  readonly lines: readonly PublicQuoteLineDto[];
  readonly totalAmountMinor: string;
  readonly totalFormatted: string;
  readonly seats: number;
  readonly priceListVersion: number;
  readonly cancellationPolicyVersion: number;
  readonly rules: readonly CancellationRule[];
  readonly weatherClause: string | null;
  readonly quotedAt: string;
  readonly snapshotHash: string;
}

export interface ProblemDetailsError {
  readonly status?: number;
  readonly title?: string;
  readonly detail?: string;
  readonly i18nKey?: string;
  readonly i18nParams?: Readonly<Record<string, string | number>>;
  readonly errorCode?: string;
}

const DEFAULT_API_INTERNAL_URL = 'http://localhost:4000';
const AVAILABILITY_WINDOW_DAYS = 14;
const MAX_PUBLIC_WINDOW_OFFSET_DAYS = 61;

export function getApiInternalBaseUrl(): string {
  const raw = process.env['API_INTERNAL_URL']?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_API_INTERNAL_URL;
  return base.replace(/\/+$/, '');
}

export async function fetchCatalogList(
  query: {
    readonly locale: BuiltinLocale;
    readonly q?: string;
    readonly kind?: string;
    readonly cursor?: string;
    readonly limit?: number;
  },
  fetchFn: typeof fetch = fetch,
): Promise<PublicCatalogListResponse> {
  const params = new URLSearchParams();
  params.set('locale', query.locale);
  if (query.q && query.q.trim().length > 0) {
    params.set('q', query.q.trim());
  }
  if (query.kind === 'tour' || query.kind === 'activity') {
    params.set('kind', query.kind);
  }
  if (query.cursor && query.cursor.trim().length > 0) {
    params.set('cursor', query.cursor.trim());
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }

  const res = await fetchFn(`${getApiInternalBaseUrl()}/catalog/products?${params.toString()}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Catalog list API failed with status ${res.status}`);
  }
  return (await res.json()) as PublicCatalogListResponse;
}

export async function fetchCatalogDetail(
  locale: BuiltinLocale,
  slug: string,
  fetchFn: typeof fetch = fetch,
): Promise<PublicCatalogProductDetail | null> {
  const res = await fetchFn(
    `${getApiInternalBaseUrl()}/catalog/products/${encodeURIComponent(locale)}/${encodeURIComponent(slug)}`,
    { cache: 'no-store' },
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Catalog detail API failed with status ${res.status}`);
  }
  return (await res.json()) as PublicCatalogProductDetail;
}

export async function fetchAvailability(
  productId: string,
  fromDate: string,
  toDate: string,
  fetchFn: typeof fetch = fetch,
): Promise<PublicAvailabilityResponse> {
  const params = new URLSearchParams({ from: fromDate, to: toDate });
  const res = await fetchFn(
    `${getApiInternalBaseUrl()}/catalog/products/${encodeURIComponent(productId)}/availability?${params.toString()}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    throw new Error(`Availability API failed with status ${res.status}`);
  }
  return (await res.json()) as PublicAvailabilityResponse;
}

export function formatDuration(minutes: number | null, locale: BuiltinLocale): string | null {
  if (minutes === null || minutes <= 0) {
    return null;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours === 0) {
    return t(locale, 'demo.list.durationMinutes', { minutes: rem });
  }
  if (rem === 0) {
    return t(locale, 'demo.list.durationHours', { hours });
  }
  return t(locale, 'demo.list.durationHoursMinutes', { hours, minutes: rem });
}

export function formatCancellationSentences(
  summary: PublicCancellationSummaryDto | null,
  locale: BuiltinLocale,
): readonly string[] {
  return formatCancellationPolicySentences(summary, locale);
}

export function computeAvailabilityWindow(
  timeZone: string,
  windowPage = 0,
  referenceNow = new Date(),
): {
  readonly fromDate: string;
  readonly toDate: string;
  readonly hasPrev: boolean;
  readonly hasNext: boolean;
} {
  const safePage = Math.max(0, windowPage);
  const today = toLocalDateTime(referenceNow.toISOString(), timeZone).slice(0, 10);
  const maxEnd = addDays(today, MAX_PUBLIC_WINDOW_OFFSET_DAYS);

  const offsetDays = safePage * AVAILABILITY_WINDOW_DAYS;
  const candidateFrom = addDays(today, offsetDays);
  const fromDate = candidateFrom > maxEnd ? maxEnd : candidateFrom;
  const candidateTo = addDays(fromDate, AVAILABILITY_WINDOW_DAYS - 1);
  const toDate = candidateTo > maxEnd ? maxEnd : candidateTo;

  return {
    fromDate,
    toDate,
    hasPrev: safePage > 0,
    hasNext: toDate < maxEnd,
  };
}

export function groupDeparturesByDate(items: readonly PublicAvailabilityItem[]): ReadonlyArray<{
  readonly localDate: string;
  readonly departures: readonly PublicAvailabilityItem[];
}> {
  const map = new Map<string, PublicAvailabilityItem[]>();
  for (const item of items) {
    const bucket = map.get(item.localDate);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(item.localDate, [item]);
    }
  }
  return [...map.entries()].map(([localDate, departures]) => ({ localDate, departures }));
}

export function formatLocalTimeShort(localTime: string): string {
  return localTime.slice(0, 5);
}

export function resolveQuoteErrorMessage(
  err: ProblemDetailsError | null | undefined,
  locale: BuiltinLocale,
): string {
  if (err?.detail && err.detail.trim().length > 0) {
    return err.detail;
  }
  if (err?.i18nKey) {
    try {
      return t(locale, err.i18nKey, err.i18nParams);
    } catch {
      return t(locale, 'demo.detail.quoteErrorFallback');
    }
  }
  return t(locale, 'demo.detail.quoteErrorFallback');
}
