import {
  and,
  asc,
  catalogProductImages,
  catalogProducts,
  catalogProductTranslations,
  countries,
  type DatabaseClient,
  eq,
  inArray,
  MAX_PRODUCT_IMAGES,
  PRODUCT_KINDS,
  PRODUCT_SLUG_REGEX,
  PRODUCT_STATUSES,
  type ProductKind,
  type ProductStatus,
  sql,
  uuidv7,
} from '@internationalota/db';
import { isValidTimeZone } from '@internationalota/time';
import { Inject, Injectable } from '@nestjs/common';
import { LocaleService } from '../../common/i18n/locale.service.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { SupplyService } from '../supply/index.js';
import {
  catalogImagesInvalidUrlException,
  catalogImagesTooManyException,
  catalogInvalidLocaleException,
  catalogInvalidQueryException,
  catalogInvalidSlugException,
  catalogProductNotFoundException,
  catalogPublishBlockedException,
  catalogSlugConflictException,
  catalogSupplierNotFoundException,
} from './catalog.errors.js';
import type {
  AdminCatalogProductDto,
  AdminListProductsOptions,
  AdminProductListResponse,
  CreateProductInput,
  GeoPoint,
  ProductImageDto,
  ProductImageInput,
  ProductTranslationDto,
  PublicCatalogListResponse,
  PublicCatalogProductDetail,
  PublicCatalogProductSummary,
  PublicListProductsQuery,
  PublicProductImage,
  UpdateProductInput,
  UpsertTranslationInput,
} from './catalog.types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY_ALPHA2_REGEX = /^[A-Z]{2}$/;
const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_RADIUS_KM = 25;
const MAX_RADIUS_KM = 200;

interface DefaultCursorPayload {
  v: 1;
  mode: 'default';
  publishedAt: string;
  id: string;
}

interface GeoCursorPayload {
  v: 1;
  mode: 'geo';
  distanceMeters: number;
  id: string;
}

interface AdminCursorPayload {
  v: 1;
  mode: 'admin';
  createdAt: string;
  id: string;
}

type DecodedCursor = DefaultCursorPayload | GeoCursorPayload | AdminCursorPayload;

function encodeCursor(payload: DecodedCursor): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor<T extends DecodedCursor['mode']>(
  raw: string,
  expectedMode: T,
): Extract<DecodedCursor, { mode: T }> {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('invalid');
    }
    const rec = parsed as Record<string, unknown>;
    if (rec['v'] !== 1 || rec['mode'] !== expectedMode || typeof rec['id'] !== 'string') {
      throw new Error('invalid');
    }
    if (!UUID_REGEX.test(rec['id'])) {
      throw new Error('invalid id');
    }
    if (expectedMode === 'default' && typeof rec['publishedAt'] !== 'string') {
      throw new Error('invalid publishedAt');
    }
    if (expectedMode === 'admin' && typeof rec['createdAt'] !== 'string') {
      throw new Error('invalid createdAt');
    }
    if (
      expectedMode === 'geo' &&
      (typeof rec['distanceMeters'] !== 'number' || !Number.isFinite(rec['distanceMeters']))
    ) {
      throw new Error('invalid distance');
    }
    return rec as unknown as Extract<DecodedCursor, { mode: T }>;
  } catch {
    throw catalogInvalidQueryException('invalid cursor');
  }
}

function escapeLikePattern(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function validateGeoPoint(point: unknown): GeoPoint {
  if (typeof point !== 'object' || point === null) {
    throw catalogInvalidQueryException('location must be { lat, lng }');
  }
  const p = point as Record<string, unknown>;
  if (
    typeof p['lat'] !== 'number' ||
    typeof p['lng'] !== 'number' ||
    !Number.isFinite(p['lat']) ||
    !Number.isFinite(p['lng']) ||
    p['lat'] < -90 ||
    p['lat'] > 90 ||
    p['lng'] < -180 ||
    p['lng'] > 180
  ) {
    throw catalogInvalidQueryException('location coordinates out of range');
  }
  return { lat: p['lat'], lng: p['lng'] };
}

function parseNearQuery(raw: string): GeoPoint {
  const parts = raw.split(',');
  if (parts.length !== 2) {
    throw catalogInvalidQueryException('near must be "lat,lng"');
  }
  const lat = Number(parts[0]?.trim());
  const lng = Number(parts[1]?.trim());
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    throw catalogInvalidQueryException('near coordinates out of valid lat/lng bounds');
  }
  return { lat, lng };
}

function sanitizeStringArray(arr: unknown, fieldName: string): string[] {
  if (arr === undefined) {
    return [];
  }
  if (!Array.isArray(arr)) {
    throw catalogInvalidQueryException(`${fieldName} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') {
      throw catalogInvalidQueryException(`${fieldName} items must be strings`);
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
  }
  return out;
}

function validateHttpsImageUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('https://')) {
    throw catalogImagesInvalidUrlException();
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      throw catalogImagesInvalidUrlException();
    }
    return rawUrl;
  } catch {
    throw catalogImagesInvalidUrlException();
  }
}

function pickLocalizedAlt(altMap: Record<string, string>, locale: string): string | null {
  const exact = altMap[locale];
  if (typeof exact === 'string' && exact.trim().length > 0) {
    return exact;
  }
  const firstVal = Object.values(altMap).find((v) => typeof v === 'string' && v.trim().length > 0);
  return firstVal ?? null;
}

interface ProductDbRow {
  id: string;
  supplierId: string;
  kind: string;
  status: string;
  countryAlpha2: string;
  region: string;
  lat: number | null;
  lng: number | null;
  meetingPointNote: string | null;
  timeZone: string;
  durationMinutes: number | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdAtCursor?: string;
}

interface PublicQueryRow {
  id: string;
  supplierId: string;
  kind: string;
  countryAlpha2: string;
  region: string;
  lat: number | null;
  lng: number | null;
  timeZone: string;
  durationMinutes: number | null;
  publishedAt: Date;
  publishedAtCursor: string;
  locale: string;
  title: string;
  slug: string;
  summary: string;
  distanceMeters?: number;
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly supplyService: SupplyService,
    private readonly localeService: LocaleService,
  ) {}

  private async assertCountryExists(rawAlpha2: string): Promise<string> {
    const code = typeof rawAlpha2 === 'string' ? rawAlpha2.trim().toUpperCase() : '';
    if (!COUNTRY_ALPHA2_REGEX.test(code)) {
      throw catalogInvalidQueryException(`invalid countryAlpha2 "${rawAlpha2}"`);
    }
    const [row] = await this.db
      .select({ alpha2: countries.alpha2 })
      .from(countries)
      .where(eq(countries.alpha2, code));
    if (!row) {
      throw catalogInvalidQueryException(`unknown countryAlpha2 "${code}"`);
    }
    return code;
  }

  private assertTimeZone(rawTz: string): string {
    const tz = typeof rawTz === 'string' ? rawTz.trim() : '';
    if (!tz || !isValidTimeZone(tz)) {
      throw catalogInvalidQueryException(`invalid IANA timeZone "${rawTz}"`);
    }
    return tz;
  }

  private assertKind(rawKind: string): ProductKind {
    if (!(PRODUCT_KINDS as readonly string[]).includes(rawKind)) {
      throw catalogInvalidQueryException(`kind must be one of: ${PRODUCT_KINDS.join(', ')}`);
    }
    return rawKind as ProductKind;
  }

  private async loadProductRow(id: string): Promise<ProductDbRow> {
    if (!UUID_REGEX.test(id)) {
      throw catalogProductNotFoundException();
    }
    const [row] = await this.db
      .select({
        id: catalogProducts.id,
        supplierId: catalogProducts.supplierId,
        kind: catalogProducts.kind,
        status: catalogProducts.status,
        countryAlpha2: catalogProducts.countryAlpha2,
        region: catalogProducts.region,
        lat: sql<
          number | null
        >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_Y(${catalogProducts.location}::geometry) ELSE NULL END`,
        lng: sql<
          number | null
        >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_X(${catalogProducts.location}::geometry) ELSE NULL END`,
        meetingPointNote: catalogProducts.meetingPointNote,
        timeZone: catalogProducts.timeZone,
        durationMinutes: catalogProducts.durationMinutes,
        publishedAt: catalogProducts.publishedAt,
        createdAt: catalogProducts.createdAt,
        updatedAt: catalogProducts.updatedAt,
      })
      .from(catalogProducts)
      .where(eq(catalogProducts.id, id));

    if (!row) {
      throw catalogProductNotFoundException();
    }
    return row;
  }

  private toAdminDto(
    row: ProductDbRow,
    translations?: ProductTranslationDto[],
    images?: ProductImageDto[],
  ): AdminCatalogProductDto {
    return {
      id: row.id,
      supplierId: row.supplierId,
      kind: row.kind as ProductKind,
      status: row.status as ProductStatus,
      countryAlpha2: row.countryAlpha2,
      region: row.region,
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      meetingPointNote: row.meetingPointNote,
      timeZone: row.timeZone,
      durationMinutes: row.durationMinutes,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(translations !== undefined ? { translations } : {}),
      ...(images !== undefined ? { images } : {}),
    };
  }

  async createProduct(input: CreateProductInput): Promise<AdminCatalogProductDto> {
    const supplierExists = await this.supplyService.supplierExists(input.supplierId);
    if (!supplierExists) {
      throw catalogSupplierNotFoundException();
    }

    const kind = this.assertKind(input.kind);
    const countryAlpha2 = await this.assertCountryExists(input.countryAlpha2);
    const region = typeof input.region === 'string' ? input.region.trim() : '';
    if (!region) {
      throw catalogInvalidQueryException('region is required');
    }

    const point =
      input.location !== undefined && input.location !== null
        ? validateGeoPoint(input.location)
        : null;
    const timeZone =
      input.timeZone !== undefined ? this.assertTimeZone(input.timeZone) : DEFAULT_TIME_ZONE;

    let durationMinutes: number | null = null;
    if (input.durationMinutes !== undefined && input.durationMinutes !== null) {
      if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) {
        throw catalogInvalidQueryException('durationMinutes must be a positive integer');
      }
      durationMinutes = input.durationMinutes;
    }

    const meetingPointNote =
      typeof input.meetingPointNote === 'string' && input.meetingPointNote.trim().length > 0
        ? input.meetingPointNote.trim()
        : null;

    const productId = uuidv7();
    const locationExpr = point
      ? (sql`ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography` as unknown as string)
      : null;

    await this.db.insert(catalogProducts).values({
      id: productId,
      supplierId: input.supplierId,
      kind,
      status: 'draft',
      countryAlpha2,
      region,
      location: locationExpr,
      meetingPointNote,
      timeZone,
      durationMinutes,
    });

    return this.getAdminProductById(productId);
  }

  async updateProduct(id: string, input: UpdateProductInput): Promise<AdminCatalogProductDto> {
    await this.loadProductRow(id);

    const setValues: Record<string, unknown> = {
      updatedAt: sql`now()`,
    };

    if (input.kind !== undefined) {
      setValues['kind'] = this.assertKind(input.kind);
    }
    if (input.countryAlpha2 !== undefined) {
      setValues['countryAlpha2'] = await this.assertCountryExists(input.countryAlpha2);
    }
    if (input.region !== undefined) {
      const region = typeof input.region === 'string' ? input.region.trim() : '';
      if (!region) {
        throw catalogInvalidQueryException('region cannot be empty');
      }
      setValues['region'] = region;
    }
    if (input.location !== undefined) {
      if (input.location === null) {
        setValues['location'] = null;
      } else {
        const point = validateGeoPoint(input.location);
        setValues['location'] =
          sql`ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography`;
      }
    }
    if (input.meetingPointNote !== undefined) {
      setValues['meetingPointNote'] =
        typeof input.meetingPointNote === 'string' && input.meetingPointNote.trim().length > 0
          ? input.meetingPointNote.trim()
          : null;
    }
    if (input.timeZone !== undefined) {
      setValues['timeZone'] = this.assertTimeZone(input.timeZone);
    }
    if (input.durationMinutes !== undefined) {
      if (input.durationMinutes === null) {
        setValues['durationMinutes'] = null;
      } else if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) {
        throw catalogInvalidQueryException('durationMinutes must be a positive integer');
      } else {
        setValues['durationMinutes'] = input.durationMinutes;
      }
    }

    await this.db.update(catalogProducts).set(setValues).where(eq(catalogProducts.id, id));
    return this.getAdminProductById(id);
  }

  async upsertTranslation(
    productId: string,
    rawLocale: string,
    input: UpsertTranslationInput,
  ): Promise<ProductTranslationDto> {
    await this.loadProductRow(productId);

    const enabled = this.localeService.getEnabledLocales();
    if (!enabled.includes(rawLocale)) {
      throw catalogInvalidLocaleException(rawLocale);
    }

    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    if (!PRODUCT_SLUG_REGEX.test(slug)) {
      throw catalogInvalidSlugException();
    }

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!title || !summary || !description) {
      throw catalogInvalidQueryException('title, summary, and description are required');
    }

    const highlights = sanitizeStringArray(input.highlights, 'highlights');
    const inclusions = sanitizeStringArray(input.inclusions, 'inclusions');
    const exclusions = sanitizeStringArray(input.exclusions, 'exclusions');

    try {
      const [row] = await this.db
        .insert(catalogProductTranslations)
        .values({
          productId,
          locale: rawLocale,
          title,
          slug,
          summary,
          description,
          highlights,
          inclusions,
          exclusions,
        })
        .onConflictDoUpdate({
          target: [catalogProductTranslations.productId, catalogProductTranslations.locale],
          set: {
            title,
            slug,
            summary,
            description,
            highlights,
            inclusions,
            exclusions,
          },
        })
        .returning();

      return row!;
    } catch (err: unknown) {
      const pgErr = err as { code?: string; cause?: { code?: string } };
      const code = pgErr.code ?? pgErr.cause?.code;
      if (code === '23505') {
        throw catalogSlugConflictException(rawLocale, slug);
      }
      throw err;
    }
  }

  async setProductImages(
    productId: string,
    images: readonly ProductImageInput[],
  ): Promise<ProductImageDto[]> {
    await this.loadProductRow(productId);

    const rawImages: unknown = images;
    if (!Array.isArray(rawImages)) {
      throw catalogInvalidQueryException('images must be an array');
    }
    if (images.length > MAX_PRODUCT_IMAGES) {
      throw catalogImagesTooManyException();
    }

    const normalized = images.map((img, idx) => {
      const url = validateHttpsImageUrl(img.url);
      if (typeof img.alt !== 'object' || img.alt === null || Array.isArray(img.alt)) {
        throw catalogInvalidQueryException('each image alt must be a locale-keyed object');
      }
      const alt: Record<string, string> = {};
      for (const [k, v] of Object.entries(img.alt)) {
        if (typeof v !== 'string') {
          throw catalogInvalidQueryException('image alt values must be strings');
        }
        alt[k] = v.trim();
      }
      return {
        id: uuidv7(),
        productId,
        url,
        sort: idx,
        alt,
      };
    });

    await this.db.transaction(async (tx) => {
      await tx.delete(catalogProductImages).where(eq(catalogProductImages.productId, productId));
      if (normalized.length > 0) {
        await tx.insert(catalogProductImages).values(normalized);
      }
      await tx
        .update(catalogProducts)
        .set({ updatedAt: sql`now()` })
        .where(eq(catalogProducts.id, productId));
    });

    return normalized.map((img) => ({
      id: img.id,
      url: img.url,
      sort: img.sort,
      alt: img.alt,
    }));
  }

  async publishProduct(id: string): Promise<AdminCatalogProductDto> {
    const product = await this.loadProductRow(id);
    const enabledLocales = this.localeService.getEnabledLocales();

    const [supplierActive, translations] = await Promise.all([
      this.supplyService.isSupplierActive(product.supplierId),
      this.db
        .select()
        .from(catalogProductTranslations)
        .where(eq(catalogProductTranslations.productId, id)),
    ]);

    const translationMap = new Map(translations.map((tr) => [tr.locale, tr]));
    const missingLocales: string[] = [];

    for (const loc of enabledLocales) {
      const tr = translationMap.get(loc);
      if (
        !tr ||
        tr.title.trim().length === 0 ||
        tr.summary.trim().length === 0 ||
        tr.description.trim().length === 0
      ) {
        missingLocales.push(loc);
      }
    }

    const missingLocation = product.lat === null || product.lng === null;
    const missingTimeZone = !product.timeZone || !isValidTimeZone(product.timeZone);

    if (!supplierActive || missingLocales.length > 0 || missingLocation || missingTimeZone) {
      throw catalogPublishBlockedException({
        supplierSuspended: !supplierActive,
        missingLocales,
        missingLocation,
        missingTimeZone,
      });
    }

    await this.db
      .update(catalogProducts)
      .set({
        status: 'published',
        publishedAt: product.publishedAt ?? sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(catalogProducts.id, id));

    return this.getAdminProductById(id);
  }

  async archiveProduct(id: string): Promise<AdminCatalogProductDto> {
    await this.loadProductRow(id);
    await this.db
      .update(catalogProducts)
      .set({
        status: 'archived',
        updatedAt: sql`now()`,
      })
      .where(eq(catalogProducts.id, id));
    return this.getAdminProductById(id);
  }

  async getAdminProductById(id: string): Promise<AdminCatalogProductDto> {
    const row = await this.loadProductRow(id);
    const [translations, images] = await Promise.all([
      this.db
        .select()
        .from(catalogProductTranslations)
        .where(eq(catalogProductTranslations.productId, id))
        .orderBy(asc(catalogProductTranslations.locale)),
      this.db
        .select()
        .from(catalogProductImages)
        .where(eq(catalogProductImages.productId, id))
        .orderBy(asc(catalogProductImages.sort)),
    ]);

    return this.toAdminDto(
      row,
      translations,
      images.map((img) => ({
        id: img.id,
        url: img.url,
        sort: img.sort,
        alt: img.alt,
      })),
    );
  }

  async listAdminProducts(
    options: AdminListProductsOptions = {},
  ): Promise<AdminProductListResponse> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const conditions = [];

    if (options.status) {
      if (!(PRODUCT_STATUSES as readonly string[]).includes(options.status)) {
        throw catalogInvalidQueryException(`status must be one of: ${PRODUCT_STATUSES.join(', ')}`);
      }
      conditions.push(eq(catalogProducts.status, options.status));
    }

    if (options.kind) {
      conditions.push(eq(catalogProducts.kind, this.assertKind(options.kind)));
    }

    if (options.supplierId) {
      if (!UUID_REGEX.test(options.supplierId)) {
        throw catalogInvalidQueryException('invalid supplierId');
      }
      conditions.push(eq(catalogProducts.supplierId, options.supplierId));
    }

    if (options.cursor) {
      const decoded = decodeCursor(options.cursor, 'admin');
      conditions.push(
        sql`(${catalogProducts.createdAt}, ${catalogProducts.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select({
        id: catalogProducts.id,
        supplierId: catalogProducts.supplierId,
        kind: catalogProducts.kind,
        status: catalogProducts.status,
        countryAlpha2: catalogProducts.countryAlpha2,
        region: catalogProducts.region,
        lat: sql<
          number | null
        >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_Y(${catalogProducts.location}::geometry) ELSE NULL END`,
        lng: sql<
          number | null
        >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_X(${catalogProducts.location}::geometry) ELSE NULL END`,
        meetingPointNote: catalogProducts.meetingPointNote,
        timeZone: catalogProducts.timeZone,
        durationMinutes: catalogProducts.durationMinutes,
        publishedAt: catalogProducts.publishedAt,
        createdAt: catalogProducts.createdAt,
        updatedAt: catalogProducts.updatedAt,
        createdAtCursor: sql<string>`to_char(${catalogProducts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(catalogProducts)
      .where(whereClause)
      .orderBy(sql`${catalogProducts.createdAt} DESC`, sql`${catalogProducts.id} DESC`)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            v: 1,
            mode: 'admin',
            createdAt: lastRow.createdAtCursor,
            id: lastRow.id,
          })
        : null;

    return {
      items: pageRows.map((row) => this.toAdminDto(row)),
      nextCursor,
    };
  }

  // --- Public read/search API ---

  async listPublishedProducts(
    query: PublicListProductsQuery,
  ): Promise<{ locale: string; data: PublicCatalogListResponse }> {
    const resolvedLocale = this.localeService.resolveLocale(query.locale, query.acceptLanguage);

    let limit = DEFAULT_LIMIT;
    if (query.limit !== undefined && query.limit !== '') {
      const parsed = Number(query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw catalogInvalidQueryException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
      limit = parsed;
    }

    const kind = query.kind && query.kind.trim().length > 0 ? this.assertKind(query.kind) : null;
    const searchText = query.q?.trim() ?? '';

    const nearPoint =
      query.near !== undefined && query.near.trim().length > 0 ? parseNearQuery(query.near) : null;

    let radiusKm: number | null = null;
    if (query.radiusKm !== undefined && query.radiusKm !== '') {
      if (!nearPoint) {
        throw catalogInvalidQueryException('radiusKm requires near=lat,lng');
      }
      const r = Number(query.radiusKm);
      if (!Number.isFinite(r) || r <= 0 || r > MAX_RADIUS_KM) {
        throw catalogInvalidQueryException(`radiusKm must be > 0 and <= ${MAX_RADIUS_KM}`);
      }
      radiusKm = r;
    } else if (nearPoint) {
      radiusKm = DEFAULT_RADIUS_KM;
    }

    // Fetch active suppliers through Supply module's public API (no cross-module table query)
    const activeSupplierNames = await this.supplyService.getActiveSupplierDisplayMap();
    const activeSupplierIds = [...activeSupplierNames.keys()];
    if (activeSupplierIds.length === 0) {
      return { locale: resolvedLocale, data: { items: [], nextCursor: null } };
    }

    const conditions = [
      eq(catalogProducts.status, 'published'),
      sql`${catalogProducts.publishedAt} IS NOT NULL`,
      inArray(catalogProducts.supplierId, activeSupplierIds),
      eq(catalogProductTranslations.locale, resolvedLocale),
    ];

    if (kind) {
      conditions.push(eq(catalogProducts.kind, kind));
    }

    if (searchText.length > 0) {
      const escaped = escapeLikePattern(searchText);
      const pattern = `%${escaped}%`;
      conditions.push(
        sql`catalog.immutable_unaccent(lower(${catalogProductTranslations.title} || ' ' || ${catalogProductTranslations.summary})) LIKE catalog.immutable_unaccent(lower(${pattern})) ESCAPE '\\'`,
      );
    }

    let rows: PublicQueryRow[];

    if (nearPoint && radiusKm !== null) {
      const radiusMeters = radiusKm * 1000;
      const pointSql = sql`ST_SetSRID(ST_MakePoint(${nearPoint.lng}, ${nearPoint.lat}), 4326)::geography`;

      conditions.push(sql`${catalogProducts.location} IS NOT NULL`);
      conditions.push(sql`ST_DWithin(${catalogProducts.location}, ${pointSql}, ${radiusMeters})`);

      const distanceExpr = sql<number>`ST_Distance(${catalogProducts.location}, ${pointSql})`;
      let cursorCondition = sql``;

      if (query.cursor) {
        const decoded = decodeCursor(query.cursor, 'geo');
        cursorCondition = sql`WHERE (sub.distance_meters > ${decoded.distanceMeters}::double precision OR (sub.distance_meters = ${decoded.distanceMeters}::double precision AND sub.id > ${decoded.id}::uuid))`;
      }

      const whereSql = and(...conditions);
      const result = await this.db.execute(sql`
        SELECT * FROM (
          SELECT
            ${catalogProducts.id} AS "id",
            ${catalogProducts.supplierId} AS "supplierId",
            ${catalogProducts.kind} AS "kind",
            ${catalogProducts.countryAlpha2} AS "countryAlpha2",
            ${catalogProducts.region} AS "region",
            ST_Y(${catalogProducts.location}::geometry) AS "lat",
            ST_X(${catalogProducts.location}::geometry) AS "lng",
            ${catalogProducts.timeZone} AS "timeZone",
            ${catalogProducts.durationMinutes} AS "durationMinutes",
            ${catalogProducts.publishedAt} AS "publishedAt",
            to_char(${catalogProducts.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAtCursor",
            ${catalogProductTranslations.locale} AS "locale",
            ${catalogProductTranslations.title} AS "title",
            ${catalogProductTranslations.slug} AS "slug",
            ${catalogProductTranslations.summary} AS "summary",
            ${distanceExpr} AS distance_meters
          FROM ${catalogProducts}
          INNER JOIN ${catalogProductTranslations}
            ON ${catalogProductTranslations.productId} = ${catalogProducts.id}
          WHERE ${whereSql}
        ) sub
        ${cursorCondition}
        ORDER BY sub.distance_meters ASC, sub.id ASC
        LIMIT ${limit + 1}
      `);

      rows = result.rows.map((rec) => {
        return {
          id: String(rec['id']),
          supplierId: String(rec['supplierId']),
          kind: String(rec['kind']),
          countryAlpha2: String(rec['countryAlpha2']),
          region: String(rec['region']),
          lat: typeof rec['lat'] === 'number' ? rec['lat'] : null,
          lng: typeof rec['lng'] === 'number' ? rec['lng'] : null,
          timeZone: String(rec['timeZone']),
          durationMinutes:
            typeof rec['durationMinutes'] === 'number' ? rec['durationMinutes'] : null,
          publishedAt: new Date(String(rec['publishedAt'])),
          publishedAtCursor: String(rec['publishedAtCursor']),
          locale: String(rec['locale']),
          title: String(rec['title']),
          slug: String(rec['slug']),
          summary: String(rec['summary']),
          distanceMeters: Number(rec['distance_meters']),
        };
      });
    } else {
      if (query.cursor) {
        const decoded = decodeCursor(query.cursor, 'default');
        conditions.push(
          sql`(${catalogProducts.publishedAt}, ${catalogProducts.id}) < (${decoded.publishedAt}::timestamptz, ${decoded.id}::uuid)`,
        );
      }

      const rawRows = await this.db
        .select({
          id: catalogProducts.id,
          supplierId: catalogProducts.supplierId,
          kind: catalogProducts.kind,
          countryAlpha2: catalogProducts.countryAlpha2,
          region: catalogProducts.region,
          lat: sql<
            number | null
          >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_Y(${catalogProducts.location}::geometry) ELSE NULL END`,
          lng: sql<
            number | null
          >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_X(${catalogProducts.location}::geometry) ELSE NULL END`,
          timeZone: catalogProducts.timeZone,
          durationMinutes: catalogProducts.durationMinutes,
          publishedAt: catalogProducts.publishedAt,
          publishedAtCursor: sql<string>`to_char(${catalogProducts.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          locale: catalogProductTranslations.locale,
          title: catalogProductTranslations.title,
          slug: catalogProductTranslations.slug,
          summary: catalogProductTranslations.summary,
        })
        .from(catalogProducts)
        .innerJoin(
          catalogProductTranslations,
          eq(catalogProductTranslations.productId, catalogProducts.id),
        )
        .where(and(...conditions))
        .orderBy(sql`${catalogProducts.publishedAt} DESC`, sql`${catalogProducts.id} DESC`)
        .limit(limit + 1);

      rows = rawRows.map((r) => ({
        ...r,
        publishedAt: r.publishedAt!,
      }));
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const productIds = pageRows.map((r) => r.id);
    const primaryImageByProduct = new Map<string, PublicProductImage>();
    if (productIds.length > 0) {
      const images = await this.db
        .select()
        .from(catalogProductImages)
        .where(inArray(catalogProductImages.productId, productIds))
        .orderBy(asc(catalogProductImages.productId), asc(catalogProductImages.sort));

      for (const img of images) {
        if (!primaryImageByProduct.has(img.productId)) {
          primaryImageByProduct.set(img.productId, {
            url: img.url,
            sort: img.sort,
            alt: pickLocalizedAlt(img.alt, resolvedLocale),
          });
        }
      }
    }

    const items: PublicCatalogProductSummary[] = pageRows.map((row) => ({
      id: row.id,
      kind: row.kind as ProductKind,
      locale: row.locale,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      countryAlpha2: row.countryAlpha2,
      region: row.region,
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      timeZone: row.timeZone,
      durationMinutes: row.durationMinutes,
      publishedAt: row.publishedAt.toISOString(),
      supplierName: activeSupplierNames.get(row.supplierId) ?? '',
      primaryImage: primaryImageByProduct.get(row.id) ?? null,
      ...(row.distanceMeters !== undefined
        ? { distanceMeters: Math.round(row.distanceMeters) }
        : {}),
    }));

    const lastRow = pageRows[pageRows.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && lastRow) {
      nextCursor =
        nearPoint && lastRow.distanceMeters !== undefined
          ? encodeCursor({
              v: 1,
              mode: 'geo',
              distanceMeters: lastRow.distanceMeters,
              id: lastRow.id,
            })
          : encodeCursor({
              v: 1,
              mode: 'default',
              publishedAt: lastRow.publishedAtCursor,
              id: lastRow.id,
            });
    }

    return {
      locale: resolvedLocale,
      data: {
        items,
        nextCursor,
      },
    };
  }

  async getPublishedProductBySlug(
    locale: string,
    slug: string,
  ): Promise<PublicCatalogProductDetail> {
    const enabled = this.localeService.getEnabledLocales();
    if (!enabled.includes(locale) || !PRODUCT_SLUG_REGEX.test(slug)) {
      throw catalogProductNotFoundException();
    }

    const [row] = await this.db
      .select({
        id: catalogProducts.id,
        supplierId: catalogProducts.supplierId,
        kind: catalogProducts.kind,
        countryAlpha2: catalogProducts.countryAlpha2,
        region: catalogProducts.region,
        lat: sql<
          number | null
        >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_Y(${catalogProducts.location}::geometry) ELSE NULL END`,
        lng: sql<
          number | null
        >`CASE WHEN ${catalogProducts.location} IS NOT NULL THEN ST_X(${catalogProducts.location}::geometry) ELSE NULL END`,
        meetingPointNote: catalogProducts.meetingPointNote,
        timeZone: catalogProducts.timeZone,
        durationMinutes: catalogProducts.durationMinutes,
        publishedAt: catalogProducts.publishedAt,
        locale: catalogProductTranslations.locale,
        title: catalogProductTranslations.title,
        slug: catalogProductTranslations.slug,
        summary: catalogProductTranslations.summary,
        description: catalogProductTranslations.description,
        highlights: catalogProductTranslations.highlights,
        inclusions: catalogProductTranslations.inclusions,
        exclusions: catalogProductTranslations.exclusions,
      })
      .from(catalogProducts)
      .innerJoin(
        catalogProductTranslations,
        eq(catalogProductTranslations.productId, catalogProducts.id),
      )
      .where(
        and(
          eq(catalogProductTranslations.locale, locale),
          eq(catalogProductTranslations.slug, slug),
          eq(catalogProducts.status, 'published'),
        ),
      );

    if (!row || !row.publishedAt) {
      throw catalogProductNotFoundException();
    }

    const supplierName = await this.supplyService.getActiveSupplierDisplayName(row.supplierId);
    if (!supplierName) {
      // Supplier is suspended -> treat as 404 with no existence leak
      throw catalogProductNotFoundException();
    }

    const imageRows = await this.db
      .select()
      .from(catalogProductImages)
      .where(eq(catalogProductImages.productId, row.id))
      .orderBy(asc(catalogProductImages.sort));

    const images: PublicProductImage[] = imageRows.map((img) => ({
      url: img.url,
      sort: img.sort,
      alt: pickLocalizedAlt(img.alt, locale),
    }));

    return {
      id: row.id,
      kind: row.kind as ProductKind,
      locale: row.locale,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      description: row.description,
      countryAlpha2: row.countryAlpha2,
      region: row.region,
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      meetingPointNote: row.meetingPointNote,
      timeZone: row.timeZone,
      durationMinutes: row.durationMinutes,
      publishedAt: row.publishedAt.toISOString(),
      supplierName,
      primaryImage: images[0] ?? null,
      highlights: row.highlights,
      inclusions: row.inclusions,
      exclusions: row.exclusions,
      images,
    };
  }
}
