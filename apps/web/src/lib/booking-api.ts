import { formatMoney, t, type BuiltinLocale } from '@internationalota/i18n';
import { assertSupportedCurrency, createMoney } from '@internationalota/money';
import { addDays } from '@internationalota/time';
import type {
  CancellationRule,
  PaxType,
  ProblemDetailsError,
  PublicAvailabilityItem,
  PublicQuoteResponse,
} from './catalog-api';

export const MAX_PAX_TOTAL = 50;
export const PAX_STORAGE_KEY = 'ota.demo.lastPax';

export interface PaxSelection {
  readonly adult: number;
  readonly child: number;
  readonly infant: number;
}

export interface PublicPaxAgeBandDto {
  readonly paxType: PaxType;
  readonly minAge: number;
  readonly maxAge: number | null;
  readonly occupiesSeat: boolean;
}

export interface PublicQuoteWithBands extends PublicQuoteResponse {
  readonly ageBands?: readonly PublicPaxAgeBandDto[];
}

export type BookingStatus = 'held' | 'payment_pending' | 'confirmed' | 'expired' | 'cancelled';

export interface BookingDetailDto {
  readonly id: string;
  readonly reference: string;
  readonly customerUserId: string;
  readonly productId: string;
  readonly departureId: string;
  readonly status: BookingStatus;
  readonly pax: {
    readonly adult: number;
    readonly child: number;
    readonly infant: number;
  };
  readonly seats: number;
  readonly currency: string;
  readonly totalAmountMinor: string;
  readonly quoteSnapshot: {
    readonly productId: string;
    readonly departureId: string;
    readonly startsAt: string;
    readonly localDate: string;
    readonly currency: string;
    readonly lines: readonly {
      readonly paxType: PaxType;
      readonly quantity: number;
      readonly unitAmountMinor: string;
      readonly lineAmountMinor: string;
    }[];
    readonly totalAmountMinor: string;
    readonly seats: number;
    readonly priceListVersion: number;
    readonly cancellationPolicyVersion: number;
    readonly rules: readonly CancellationRule[];
    readonly weatherClause: string | null;
  };
  readonly snapshotHash: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly contactLocale: string;
  readonly holdExpiresAt: string;
  readonly paymentRef: string | null;
  readonly version: number;
  readonly confirmedAt: string | null;
  readonly expiredAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payment?: {
    readonly status: string | null;
    readonly attemptCount: number;
  };
  readonly refund?: {
    readonly amountMinor: string;
    readonly status: string;
  };
}

export interface HoldBookingResponseDto {
  readonly id: string;
  readonly reference: string;
  readonly status: BookingStatus;
  readonly holdExpiresAt: string;
  readonly totalAmountMinor: string;
  readonly currency: string;
  readonly seats: number;
  readonly quote: PublicQuoteResponse;
}

export interface CustomerBookingListResponse {
  readonly items: readonly BookingDetailDto[];
  readonly nextCursor: string | null;
}

export interface InitiateCheckoutResponseDto {
  readonly attemptId: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly redirectUrl: string;
}

export interface BookingCancellationPreviewDto {
  readonly status: string;
  readonly currency: string;
  readonly totalAmountMinor: string;
  readonly refundAmountMinor: string;
  readonly refundPercent?: number;
  readonly ruleApplied?: {
    readonly hoursBeforeStart: number;
    readonly refundPercent: number;
  } | null;
  readonly cancellable: boolean;
  readonly reason?: 'not_paid' | 'too_late_to_cancel' | 'already_cancelled' | 'not_cancellable';
}

export interface ConfirmedCancelResponseDto extends BookingDetailDto {
  readonly refundAmountMinor: string;
  readonly refundPercent: number;
  readonly ruleApplied: {
    readonly hoursBeforeStart: number;
    readonly refundPercent: number;
  } | null;
}

export type HoldSubmitFailure =
  | { readonly kind: 'price_changed'; readonly quote: PublicQuoteResponse }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'sold_out' | 'closed' | 'cutoff_passed';
      readonly message: string;
    }
  | { readonly kind: 'too_many_active_holds'; readonly message: string }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'error'; readonly message: string };

export type ReturnPageStatusKind = 'confirmed' | 'failed' | 'processing' | 'timed_out';

export interface ReturnPageViewState {
  readonly kind: ReturnPageStatusKind;
  readonly canRetry: boolean;
}

export function normalizePaxSelection(
  raw: Partial<Record<'adult' | 'child' | 'infant', number | string | null | undefined>>,
): PaxSelection {
  const parseNonNeg = (v: number | string | null | undefined, min: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
    if (!Number.isFinite(n)) {
      return min;
    }
    return Math.max(min, Math.trunc(n));
  };

  let adult = parseNonNeg(raw.adult, 1);
  let child = parseNonNeg(raw.child, 0);
  let infant = parseNonNeg(raw.infant, 0);

  if (adult + child + infant > MAX_PAX_TOTAL) {
    adult = Math.min(adult, MAX_PAX_TOTAL);
    const remAfterAdult = Math.max(0, MAX_PAX_TOTAL - adult);
    child = Math.min(child, remAfterAdult);
    const remAfterChild = Math.max(0, remAfterAdult - child);
    infant = Math.min(infant, remAfterChild);
  }

  return { adult, child, infant };
}

export function applyPaxDelta(current: PaxSelection, field: PaxType, delta: number): PaxSelection {
  const next = { ...current };
  const total = current.adult + current.child + current.infant;
  if (delta > 0 && total >= MAX_PAX_TOTAL) {
    return current;
  }
  const minVal = field === 'adult' ? 1 : 0;
  const maxAllowedForField =
    delta > 0 ? current[field] + Math.max(0, MAX_PAX_TOTAL - total) : current[field];
  const candidate = Math.max(minVal, Math.min(maxAllowedForField, current[field] + delta));
  next[field] = candidate;
  return next;
}

export function saveLastPaxSelection(pax: PaxSelection): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(PAX_STORAGE_KEY, JSON.stringify(pax));
    }
  } catch {
    // Storage may be unavailable or restricted; ignore silently.
  }
}

export function loadLastPaxSelection(): PaxSelection | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    const raw = window.localStorage.getItem(PAX_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PaxSelection> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return normalizePaxSelection(parsed);
  } catch {
    return null;
  }
}

export function isValidE164Phone(raw: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(raw.trim());
}

export function generateIdempotencyKey(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return `web-${globalThis.crypto.randomUUID()}`;
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildAvailabilityDateStrip(
  fromDate: string,
  departures: readonly PublicAvailabilityItem[],
  daysCount = 14,
): ReadonlyArray<{
  readonly localDate: string;
  readonly departures: readonly PublicAvailabilityItem[];
  readonly openCount: number;
}> {
  const byDate = new Map<string, PublicAvailabilityItem[]>();
  for (const dep of departures) {
    const bucket = byDate.get(dep.localDate);
    if (bucket) {
      bucket.push(dep);
    } else {
      byDate.set(dep.localDate, [dep]);
    }
  }

  const strip: Array<{
    readonly localDate: string;
    readonly departures: readonly PublicAvailabilityItem[];
    readonly openCount: number;
  }> = [];

  for (let i = 0; i < daysCount; i += 1) {
    const localDate = addDays(fromDate, i);
    const dayDeps = byDate.get(localDate) ?? [];
    const openCount = dayDeps.filter((d) => d.status === 'available' && d.remaining > 0).length;
    strip.push({ localDate, departures: dayDeps, openCount });
  }
  return strip;
}

export function formatPaxStepperLabel(
  paxType: PaxType,
  locale: BuiltinLocale,
  ageBands?: readonly PublicPaxAgeBandDto[],
): string {
  const base = t(locale, `demo.detail.pax.${paxType}`);
  const band = ageBands?.find((b) => b.paxType === paxType);
  if (!band) {
    return base;
  }
  if (band.maxAge !== null) {
    return t(locale, 'demo.detail.paxAgeRange', {
      label: base,
      min: band.minAge,
      max: band.maxAge,
    });
  }
  return t(locale, 'demo.detail.paxAgeMinOnly', {
    label: base,
    min: band.minAge,
  });
}

export function formatExactMinor(
  minorStr: string,
  currencyRaw: string,
  locale: BuiltinLocale,
): string {
  const cleanCurrency = currencyRaw.trim();
  assertSupportedCurrency(cleanCurrency);
  return formatMoney(createMoney(BigInt(minorStr), cleanCurrency), locale);
}

export function computeHoldCountdown(
  holdExpiresAtIso: string,
  serverNowMs: number,
): {
  readonly expired: boolean;
  readonly remainingSeconds: number;
  readonly formatted: string;
} {
  const expiresMs = Date.parse(holdExpiresAtIso);
  if (!Number.isFinite(expiresMs) || expiresMs <= serverNowMs) {
    return { expired: true, remainingSeconds: 0, formatted: '00:00' };
  }
  const remainingSeconds = Math.max(0, Math.floor((expiresMs - serverNowMs) / 1000));
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  return {
    expired: false,
    remainingSeconds,
    formatted: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
  };
}

export function classifyHoldError(
  status: number,
  body: unknown,
  locale: BuiltinLocale,
): HoldSubmitFailure {
  if (status === 401) {
    return { kind: 'unauthenticated' };
  }
  const rec = (body && typeof body === 'object' ? body : {}) as ProblemDetailsError & {
    readonly code?: string;
    readonly errorCode?: string;
    readonly quote?: PublicQuoteResponse;
  };
  const code = rec.code ?? rec.errorCode;

  if (status === 409 && code === 'price_changed' && rec.quote) {
    return { kind: 'price_changed', quote: rec.quote };
  }

  const resolveMsg = (preferredKey: string): string => {
    const mappedByCode: Readonly<Record<string, string>> = {
      sold_out: 'booking.hold.soldOut',
      closed: 'booking.hold.closed',
      cutoff_passed: 'booking.hold.cutoffPassed',
      too_many_active_holds: 'booking.hold.tooManyActiveHolds',
      email_not_verified: 'booking.hold.emailNotVerified',
      price_changed: 'booking.hold.priceChanged',
    };
    const keyToUse = (code && mappedByCode[code]) ?? preferredKey;
    if (rec.i18nKey && rec.i18nKey.includes('.')) {
      const candidate = t(locale, rec.i18nKey, rec.i18nParams);
      if (candidate !== rec.i18nKey) {
        return candidate;
      }
    }
    if (typeof rec.detail === 'string' && rec.detail.trim().length > 0) {
      return rec.detail;
    }
    if (keyToUse) {
      return t(locale, keyToUse, rec.i18nParams);
    }
    return t(locale, 'demo.book.retrySamePriceError');
  };

  if (code === 'sold_out' || code === 'closed' || code === 'cutoff_passed') {
    return {
      kind: 'unavailable',
      reason: code,
      message: resolveMsg('demo.book.unavailableTitle'),
    };
  }

  if (code === 'too_many_active_holds') {
    return {
      kind: 'too_many_active_holds',
      message: resolveMsg('booking.hold.tooManyActiveHolds'),
    };
  }

  return {
    kind: 'error',
    message: resolveMsg('demo.book.retrySamePriceError'),
  };
}

/**
 * Determines payment return page presentation strictly from server-side booking detail,
 * intentionally ignoring any URL query parameters.
 */
export function resolveReturnViewState(
  booking: BookingDetailDto,
  timedOut: boolean,
): ReturnPageViewState {
  if (booking.status === 'confirmed') {
    return { kind: 'confirmed', canRetry: false };
  }
  if (booking.status === 'cancelled' || booking.status === 'expired') {
    return { kind: 'failed', canRetry: false };
  }
  if (booking.status === 'held') {
    if ((booking.payment?.attemptCount ?? 0) > 0 || booking.payment?.status === 'failed') {
      return { kind: 'failed', canRetry: true };
    }
    return { kind: timedOut ? 'timed_out' : 'processing', canRetry: true };
  }
  // status === 'payment_pending'
  if (booking.payment?.status === 'failed') {
    return { kind: 'failed', canRetry: true };
  }
  return { kind: timedOut ? 'timed_out' : 'processing', canRetry: false };
}

export function formatCancelPreviewMessage(
  preview: BookingCancellationPreviewDto,
  locale: BuiltinLocale,
): string {
  if (!preview.cancellable && preview.reason === 'too_late_to_cancel') {
    return t(locale, 'demo.booking.cancelPreviewTooLate');
  }
  if (preview.reason === 'not_paid') {
    return t(locale, 'demo.booking.cancelPreviewNotPaid');
  }
  const percent = preview.refundPercent ?? 0;
  if (percent <= 0 || BigInt(preview.refundAmountMinor) <= 0n) {
    return t(locale, 'demo.booking.cancelPreviewNoRefundPaid');
  }
  const amount = formatExactMinor(preview.refundAmountMinor, preview.currency, locale);
  return t(locale, 'demo.booking.cancelPreviewRefund', { amount, percent });
}
