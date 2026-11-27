import type { ProductKind, ProductStatus } from '@internationalota/db';
import type { PublicCancellationSummaryDto, PublicFromPriceDto } from '../pricing/index.js';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface ProductTranslationDto {
  readonly productId: string;
  readonly locale: string;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly description: string;
  readonly highlights: readonly string[];
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
}

export interface ProductImageInput {
  readonly url: string;
  readonly alt: Record<string, string>;
}

export interface ProductImageDto {
  readonly id: string;
  readonly url: string;
  readonly sort: number;
  readonly alt: Record<string, string>;
}

export interface AdminCatalogProductDto {
  readonly id: string;
  readonly supplierId: string;
  readonly kind: ProductKind;
  readonly status: ProductStatus;
  readonly countryAlpha2: string;
  readonly region: string;
  readonly location: GeoPoint | null;
  readonly meetingPointNote: string | null;
  readonly timeZone: string;
  readonly durationMinutes: number | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly translations?: readonly ProductTranslationDto[];
  readonly images?: readonly ProductImageDto[];
}

export interface PublicProductImage {
  readonly url: string;
  readonly sort: number;
  readonly alt: string | null;
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
  readonly location: GeoPoint | null;
  readonly timeZone: string;
  readonly durationMinutes: number | null;
  readonly publishedAt: string;
  readonly supplierName: string;
  readonly primaryImage: PublicProductImage | null;
  readonly fromPrice: PublicFromPriceDto | null;
  readonly distanceMeters?: number;
}

export interface PublicCatalogProductDetail extends PublicCatalogProductSummary {
  readonly description: string;
  readonly meetingPointNote: string | null;
  readonly highlights: readonly string[];
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly images: readonly PublicProductImage[];
  readonly cancellationSummary: PublicCancellationSummaryDto | null;
  readonly alternateSlugs: Readonly<Record<string, string>>;
}

export interface PublicCatalogListResponse {
  readonly items: readonly PublicCatalogProductSummary[];
  readonly nextCursor: string | null;
}

export interface AdminProductListResponse {
  readonly items: readonly AdminCatalogProductDto[];
  readonly nextCursor: string | null;
}

export interface CreateProductInput {
  readonly supplierId: string;
  readonly kind: ProductKind;
  readonly countryAlpha2: string;
  readonly region: string;
  readonly location?: GeoPoint | null;
  readonly meetingPointNote?: string | null;
  readonly timeZone?: string;
  readonly durationMinutes?: number | null;
}

export interface UpdateProductInput {
  readonly kind?: ProductKind;
  readonly countryAlpha2?: string;
  readonly region?: string;
  readonly location?: GeoPoint | null;
  readonly meetingPointNote?: string | null;
  readonly timeZone?: string;
  readonly durationMinutes?: number | null;
}

export interface UpsertTranslationInput {
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly description: string;
  readonly highlights?: readonly string[];
  readonly inclusions?: readonly string[];
  readonly exclusions?: readonly string[];
}

export interface AdminListProductsOptions {
  readonly status?: string;
  readonly kind?: string;
  readonly supplierId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PublicListProductsQuery {
  readonly locale?: string;
  readonly acceptLanguage?: string | string[];
  readonly kind?: string;
  readonly q?: string;
  readonly near?: string;
  readonly radiusKm?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

export interface CatalogInventoryTarget {
  readonly id: string;
  readonly kind: ProductKind;
  readonly status: ProductStatus;
  readonly timeZone: string;
}

export interface CatalogPublicVisibility {
  readonly visible: boolean;
  readonly kind: ProductKind | null;
  readonly timeZone: string | null;
}
