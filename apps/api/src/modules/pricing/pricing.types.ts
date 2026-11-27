import type { PaxType } from '@internationalota/db';
import type { CurrencyCode } from '@internationalota/money';

export interface CancellationRule {
  readonly hoursBeforeStart: number;
  readonly refundPercent: number;
}

export interface ComputeRefundInput {
  readonly rules: readonly CancellationRule[];
  readonly startsAt: Date | string;
  readonly cancelledAt: Date | string;
  readonly paidAmountMinor: bigint;
  readonly currency: CurrencyCode;
}

export interface ComputeRefundResult {
  readonly refundPercent: number;
  readonly refundAmountMinor: bigint;
  readonly ruleApplied: CancellationRule | null;
}

export interface PriceListItemInput {
  readonly paxType: PaxType;
  readonly amountMinor: string | bigint;
  readonly minAge: number;
  readonly maxAge?: number | null;
  readonly occupiesSeat: boolean;
}

export interface CreatePriceListInput {
  readonly currency: string;
  readonly validFrom: string;
  readonly validTo?: string | null;
  readonly items: readonly PriceListItemInput[];
}

export interface PriceListItemDto {
  readonly paxType: PaxType;
  readonly amountMinor: string;
  readonly minAge: number;
  readonly maxAge: number | null;
  readonly occupiesSeat: boolean;
}

export interface AdminPriceListDto {
  readonly id: string;
  readonly productId: string;
  readonly version: number;
  readonly currency: CurrencyCode;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly items: readonly PriceListItemDto[];
}

export interface AdminPriceListCollectionResponse {
  readonly items: readonly AdminPriceListDto[];
}

export interface CreateCancellationPolicyInput {
  readonly rules: readonly CancellationRule[];
  readonly weatherClause?: string | null;
}

export interface AdminCancellationPolicyDto {
  readonly id: string;
  readonly productId: string;
  readonly version: number;
  readonly rules: readonly CancellationRule[];
  readonly weatherClause: string | null;
  readonly createdAt: string;
}

export interface AdminCancellationPolicyCollectionResponse {
  readonly items: readonly AdminCancellationPolicyDto[];
}

export interface QuotePaxInput {
  readonly adult: number;
  readonly child?: number;
  readonly infant?: number;
}

export interface QuoteInput {
  readonly departureId: string;
  readonly pax: QuotePaxInput;
}

export interface QuoteLineDto {
  readonly paxType: PaxType;
  readonly quantity: number;
  readonly unitAmountMinor: string;
  readonly lineAmountMinor: string;
}

export interface QuoteSnapshot {
  readonly productId: string;
  readonly departureId: string;
  readonly startsAt: string;
  readonly localDate: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly QuoteLineDto[];
  readonly totalAmountMinor: string;
  readonly seats: number;
  readonly priceListId: string;
  readonly priceListVersion: number;
  readonly cancellationPolicyId: string;
  readonly cancellationPolicyVersion: number;
  readonly rules: readonly CancellationRule[];
  readonly weatherClause: string | null;
  readonly quotedAt: string;
  readonly snapshotHash: string;
}

export type QuoteErrorCode =
  'no_price' | 'no_policy' | 'pax_type_not_offered' | 'invalid_pax' | 'departure_not_found';

export type QuoteResult =
  | { readonly ok: true; readonly snapshot: QuoteSnapshot }
  | {
      readonly ok: false;
      readonly code: QuoteErrorCode;
      readonly i18nKey: string;
      readonly i18nParams?: Readonly<Record<string, string | number>>;
      readonly message: string;
    };

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
  readonly currency: CurrencyCode;
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

export interface PublicFromPriceDto {
  readonly currency: CurrencyCode;
  readonly amountMinor: string;
  readonly formatted: string;
}

export interface PublicCancellationSummaryDto {
  readonly version: number;
  readonly rules: readonly CancellationRule[];
  readonly weatherClause: string | null;
}

export interface PublicProductPricingSummary {
  readonly fromPrice: PublicFromPriceDto | null;
  readonly cancellationSummary: PublicCancellationSummaryDto | null;
}

export interface PricingSummaryPort {
  getPublicProductSummaryPricing(
    productId: string,
    timeZone: string,
    locale: string,
  ): Promise<PublicProductPricingSummary>;

  getPublicProductsFromPrices(
    products: readonly { readonly id: string; readonly timeZone: string }[],
    locale: string,
  ): Promise<ReadonlyMap<string, PublicFromPriceDto | null>>;
}
