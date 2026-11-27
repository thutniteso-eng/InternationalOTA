import { createHash } from 'node:crypto';
import {
  currencies,
  type DatabaseClient,
  eq,
  PAX_TYPES,
  type PaxType,
  pricingCancellationPolicies,
  pricingPriceListItems,
  pricingPriceLists,
  sql,
  uuidv7,
} from '@internationalota/db';
import { formatMoney } from '@internationalota/i18n';
import {
  assertSupportedCurrency,
  type CurrencyCode,
  createMoney,
  isSupportedCurrency,
  type Money,
  multiplyByInt,
  sum,
} from '@internationalota/money';
import { InvalidDateError, InvalidDateRangeError, parseLocalDate } from '@internationalota/time';
import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { LocaleService } from '../../common/i18n/locale.service.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { catalogProductNotFoundException, CatalogService } from '../catalog/index.js';
import { InventoryService } from '../inventory/index.js';
import {
  pricingCurrencyMismatchException,
  pricingDepartureNotFoundException,
  pricingInvalidCurrencyException,
  pricingInvalidDateRangeException,
  pricingInvalidItemsException,
  pricingInvalidQueryException,
  pricingMissingAdultItemException,
  pricingOverlappingAgeBandsException,
} from './pricing.errors.js';
import { validateCancellationRules } from './pricing.refund.js';
import type {
  AdminCancellationPolicyCollectionResponse,
  AdminCancellationPolicyDto,
  AdminPriceListCollectionResponse,
  AdminPriceListDto,
  CancellationRule,
  CreateCancellationPolicyInput,
  CreatePriceListInput,
  PriceListItemDto,
  PublicCancellationSummaryDto,
  PublicFromPriceDto,
  PublicPaxAgeBandDto,
  PublicProductPricingSummary,
  PublicQuoteLineDto,
  PublicQuoteResponse,
  QuoteInput,
  QuoteLineDto,
  QuotePaxInput,
  QuoteResult,
  QuoteSnapshot,
} from './pricing.types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_REGEX = /^\d+$/;
const MAX_PAX_TOTAL = 50;

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function parseNonNegativeMinorBigInt(raw: unknown, fieldName: string): bigint {
  if (typeof raw === 'bigint') {
    if (raw < 0n) {
      throw pricingInvalidItemsException(`${fieldName} must be >= 0`);
    }
    return raw;
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || !Number.isSafeInteger(raw) || raw < 0) {
      throw pricingInvalidItemsException(`${fieldName} must be a non-negative safe integer`);
    }
    return BigInt(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!DIGITS_REGEX.test(trimmed)) {
      throw pricingInvalidItemsException(`${fieldName} must be a non-negative integer string`);
    }
    return BigInt(trimmed);
  }
  throw pricingInvalidItemsException(`${fieldName} must be an integer or integer string`);
}

function parseNonNegIntParam(raw: string | undefined, name: string): number {
  if (raw === undefined || !DIGITS_REGEX.test(raw.trim())) {
    throw pricingInvalidQueryException(`${name} must be a non-negative integer`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw pricingInvalidQueryException(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function validatePaxCounts(pax: QuotePaxInput):
  | {
      ok: true;
      adult: number;
      child: number;
      infant: number;
    }
  | {
      ok: false;
      reason: string;
    } {
  if (typeof pax !== 'object' || pax === null) {
    return { ok: false, reason: 'pax object is required' };
  }
  const adult = pax.adult;
  const child = pax.child ?? 0;
  const infant = pax.infant ?? 0;

  if (
    !Number.isInteger(adult) ||
    !Number.isInteger(child) ||
    !Number.isInteger(infant) ||
    adult < 0 ||
    child < 0 ||
    infant < 0
  ) {
    return { ok: false, reason: 'pax counts must be non-negative integers' };
  }
  if (adult < 1) {
    return { ok: false, reason: 'at least 1 adult is required' };
  }
  const total = adult + child + infant;
  if (total < 1 || total > MAX_PAX_TOTAL) {
    return { ok: false, reason: `total pax must be between 1 and ${MAX_PAX_TOTAL}` };
  }

  return { ok: true, adult, child, infant };
}

function computeSnapshotHash(payload: Omit<QuoteSnapshot, 'quotedAt' | 'snapshotHash'>): string {
  const canonical = JSON.stringify({
    productId: payload.productId,
    departureId: payload.departureId,
    startsAt: payload.startsAt,
    localDate: payload.localDate,
    currency: payload.currency,
    lines: payload.lines.map((l) => ({
      paxType: l.paxType,
      quantity: l.quantity,
      unitAmountMinor: l.unitAmountMinor,
      lineAmountMinor: l.lineAmountMinor,
    })),
    totalAmountMinor: payload.totalAmountMinor,
    seats: payload.seats,
    priceListId: payload.priceListId,
    priceListVersion: payload.priceListVersion,
    cancellationPolicyId: payload.cancellationPolicyId,
    cancellationPolicyVersion: payload.cancellationPolicyVersion,
    rules: payload.rules.map((r) => ({
      hoursBeforeStart: r.hoursBeforeStart,
      refundPercent: r.refundPercent,
    })),
    weatherClause: payload.weatherClause,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

@Injectable()
export class PricingService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly catalogService: CatalogService,
    private readonly inventoryService: InventoryService,
    private readonly localeService: LocaleService,
  ) {}

  async createPriceList(
    productId: string,
    input: CreatePriceListInput,
    createdBy: string,
  ): Promise<AdminPriceListDto> {
    const product = await this.catalogService.getProductInventoryTarget(productId);
    if (!product) {
      throw catalogProductNotFoundException();
    }

    const rawCurrency =
      typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
    if (!rawCurrency || !isSupportedCurrency(rawCurrency)) {
      throw pricingInvalidCurrencyException(String(input.currency ?? ''));
    }

    const [currencyRow] = await this.db
      .select({ code: currencies.code })
      .from(currencies)
      .where(eq(currencies.code, rawCurrency));
    if (!currencyRow) {
      throw pricingInvalidCurrencyException(rawCurrency);
    }

    let validFrom: string;
    let validTo: string | null = null;
    try {
      validFrom = parseLocalDate(input.validFrom);
      if (input.validTo !== undefined && input.validTo !== null) {
        validTo = parseLocalDate(input.validTo);
        if (validTo < validFrom) {
          throw pricingInvalidDateRangeException('validTo must be >= validFrom');
        }
      }
    } catch (err) {
      if (err instanceof InvalidDateError || err instanceof InvalidDateRangeError) {
        throw pricingInvalidDateRangeException(err.message);
      }
      throw err;
    }

    const rawItems: unknown = input.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw pricingInvalidItemsException('items must be a non-empty array');
    }

    const seenPax = new Set<PaxType>();
    const validatedItems: Array<{
      paxType: PaxType;
      amountMinor: bigint;
      minAge: number;
      maxAge: number | null;
      occupiesSeat: boolean;
    }> = [];

    for (const rawItem of rawItems) {
      if (typeof rawItem !== 'object' || rawItem === null) {
        throw pricingInvalidItemsException('each item must be an object');
      }
      const rec = rawItem as Record<string, unknown>;
      const paxType = rec['paxType'];
      if (typeof paxType !== 'string' || !(PAX_TYPES as readonly string[]).includes(paxType)) {
        throw pricingInvalidItemsException(`paxType must be one of: ${PAX_TYPES.join(', ')}`);
      }
      const typedPax = paxType as PaxType;
      if (seenPax.has(typedPax)) {
        throw pricingInvalidItemsException(`duplicate paxType "${typedPax}"`);
      }
      seenPax.add(typedPax);

      const amountMinor = parseNonNegativeMinorBigInt(rec['amountMinor'], 'amountMinor');
      const minAge = rec['minAge'];
      const maxAge = rec['maxAge'] === undefined ? null : rec['maxAge'];
      const occupiesSeat = rec['occupiesSeat'];

      if (typeof minAge !== 'number' || !Number.isInteger(minAge) || minAge < 0 || minAge > 150) {
        throw pricingInvalidItemsException('minAge must be an integer between 0 and 150');
      }
      if (
        maxAge !== null &&
        (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < minAge || maxAge > 150)
      ) {
        throw pricingInvalidItemsException(
          'maxAge must be null or an integer >= minAge and <= 150',
        );
      }
      if (typeof occupiesSeat !== 'boolean') {
        throw pricingInvalidItemsException('occupiesSeat must be a boolean');
      }

      validatedItems.push({
        paxType: typedPax,
        amountMinor,
        minAge,
        maxAge,
        occupiesSeat,
      });
    }

    if (!seenPax.has('adult')) {
      throw pricingMissingAdultItemException();
    }

    // Check that age bands do not overlap across items in this list
    const sortedByAge = [...validatedItems].sort((a, b) => a.minAge - b.minAge);
    for (let i = 1; i < sortedByAge.length; i++) {
      const prev = sortedByAge[i - 1]!;
      const curr = sortedByAge[i]!;
      if (prev.maxAge === null || curr.minAge <= prev.maxAge) {
        throw pricingOverlappingAgeBandsException();
      }
    }

    const priceListId = uuidv7();

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`pricing_price_list:${productId}`}))`,
      );

      const existingRes = await tx.execute(sql`
        SELECT
          MAX(version)::int AS "maxVersion",
          MIN(currency)::text AS "existingCurrency"
        FROM pricing.price_lists
        WHERE product_id = ${productId}::uuid
      `);
      const stats = existingRes.rows[0] as Record<string, unknown>;
      const existingCurrency =
        typeof stats['existingCurrency'] === 'string' ? stats['existingCurrency'].trim() : null;
      if (existingCurrency !== null && existingCurrency !== rawCurrency) {
        throw pricingCurrencyMismatchException(existingCurrency, rawCurrency);
      }

      const maxVersion = typeof stats['maxVersion'] === 'number' ? stats['maxVersion'] : 0;
      const version = maxVersion + 1;

      const [insertedList] = await tx
        .insert(pricingPriceLists)
        .values({
          id: priceListId,
          productId,
          version,
          currency: rawCurrency,
          validFrom,
          validTo,
          createdBy,
        })
        .returning();

      await tx.insert(pricingPriceListItems).values(
        validatedItems.map((item) => ({
          priceListId,
          paxType: item.paxType,
          amountMinor: item.amountMinor,
          minAge: item.minAge,
          maxAge: item.maxAge,
          occupiesSeat: item.occupiesSeat,
        })),
      );

      return {
        id: insertedList!.id,
        productId: insertedList!.productId,
        version: insertedList!.version,
        currency: insertedList!.currency as CurrencyCode,
        validFrom: insertedList!.validFrom,
        validTo: insertedList!.validTo,
        createdBy: insertedList!.createdBy,
        createdAt: insertedList!.createdAt.toISOString(),
        items: validatedItems.map((it) => ({
          paxType: it.paxType,
          amountMinor: it.amountMinor.toString(),
          minAge: it.minAge,
          maxAge: it.maxAge,
          occupiesSeat: it.occupiesSeat,
        })),
      };
    });
  }

  async listPriceLists(productId: string): Promise<AdminPriceListCollectionResponse> {
    const product = await this.catalogService.getProductInventoryTarget(productId);
    if (!product) {
      throw catalogProductNotFoundException();
    }

    const lists = await this.db
      .select()
      .from(pricingPriceLists)
      .where(eq(pricingPriceLists.productId, productId))
      .orderBy(sql`${pricingPriceLists.version} DESC`);

    if (lists.length === 0) {
      return { items: [] };
    }

    const itemsRows = await this.db
      .select()
      .from(pricingPriceListItems)
      .where(
        sql`${pricingPriceListItems.priceListId} IN (${sql.join(
          lists.map((l) => sql`${l.id}::uuid`),
          sql`, `,
        )})`,
      );

    const itemsByListId = new Map<string, PriceListItemDto[]>();
    for (const row of itemsRows) {
      const list = itemsByListId.get(row.priceListId) ?? [];
      list.push({
        paxType: row.paxType as PaxType,
        amountMinor: row.amountMinor.toString(),
        minAge: row.minAge,
        maxAge: row.maxAge,
        occupiesSeat: row.occupiesSeat,
      });
      itemsByListId.set(row.priceListId, list);
    }

    return {
      items: lists.map((list) => ({
        id: list.id,
        productId: list.productId,
        version: list.version,
        currency: list.currency as CurrencyCode,
        validFrom: list.validFrom,
        validTo: list.validTo,
        createdBy: list.createdBy,
        createdAt: list.createdAt.toISOString(),
        items: itemsByListId.get(list.id) ?? [],
      })),
    };
  }

  async createCancellationPolicy(
    productId: string,
    input: CreateCancellationPolicyInput,
  ): Promise<AdminCancellationPolicyDto> {
    const product = await this.catalogService.getProductInventoryTarget(productId);
    if (!product) {
      throw catalogProductNotFoundException();
    }

    const rules = validateCancellationRules(input.rules);
    const weatherClause =
      typeof input.weatherClause === 'string' && input.weatherClause.trim().length > 0
        ? input.weatherClause.trim()
        : null;

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`pricing_policy:${productId}`}))`,
      );

      const maxRes = await tx.execute(sql`
        SELECT COALESCE(MAX(version), 0)::int AS "maxVersion"
        FROM pricing.cancellation_policies
        WHERE product_id = ${productId}::uuid
      `);
      const maxVersion = (maxRes.rows[0] as Record<string, unknown>)['maxVersion'];
      const version = (typeof maxVersion === 'number' ? maxVersion : 0) + 1;

      const [inserted] = await tx
        .insert(pricingCancellationPolicies)
        .values({
          id: uuidv7(),
          productId,
          version,
          rules,
          weatherClause,
        })
        .returning();

      return {
        id: inserted!.id,
        productId: inserted!.productId,
        version: inserted!.version,
        rules: inserted!.rules,
        weatherClause: inserted!.weatherClause,
        createdAt: inserted!.createdAt.toISOString(),
      };
    });
  }

  async listCancellationPolicies(
    productId: string,
  ): Promise<AdminCancellationPolicyCollectionResponse> {
    const product = await this.catalogService.getProductInventoryTarget(productId);
    if (!product) {
      throw catalogProductNotFoundException();
    }

    const rows = await this.db
      .select()
      .from(pricingCancellationPolicies)
      .where(eq(pricingCancellationPolicies.productId, productId))
      .orderBy(sql`${pricingCancellationPolicies.version} DESC`);

    return {
      items: rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        version: row.version,
        rules: row.rules,
        weatherClause: row.weatherClause,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Computes a deterministic immutable QuoteSnapshot for a departure and passenger mix.
   * Returns a typed QuoteResult union and uses integer/bigint arithmetic via packages/money only.
   */
  async quote(input: QuoteInput): Promise<QuoteResult> {
    const paxValidation = validatePaxCounts(input.pax);
    if (!paxValidation.ok) {
      return {
        ok: false,
        code: 'invalid_pax',
        i18nKey: 'pricing.quote.invalidPax',
        i18nParams: { reason: paxValidation.reason },
        message: `Invalid passenger counts: ${paxValidation.reason}.`,
      };
    }

    const departure = await this.inventoryService.getDepartureQuoteTarget(input.departureId);
    if (!departure) {
      return {
        ok: false,
        code: 'departure_not_found',
        i18nKey: 'pricing.quote.departureNotFound',
        message: 'Departure was not found.',
      };
    }

    const priceListRes = await this.db.execute(sql`
      SELECT id, version, currency
      FROM pricing.price_lists
      WHERE product_id = ${departure.productId}::uuid
        AND valid_from <= ${departure.localDate}::date
        AND (valid_to IS NULL OR valid_to >= ${departure.localDate}::date)
      ORDER BY version DESC
      LIMIT 1
    `);
    const priceListRow = priceListRes.rows[0];
    if (!priceListRow) {
      return {
        ok: false,
        code: 'no_price',
        i18nKey: 'pricing.quote.noPrice',
        message: 'No active price list covers the departure date.',
      };
    }

    const priceListId = String(priceListRow['id']);
    const priceListVersion =
      typeof priceListRow['version'] === 'number'
        ? priceListRow['version']
        : Number.parseInt(String(priceListRow['version']), 10);
    const currencyRaw = String(priceListRow['currency']).trim();
    assertSupportedCurrency(currencyRaw);

    const itemRows = await this.db
      .select()
      .from(pricingPriceListItems)
      .where(eq(pricingPriceListItems.priceListId, priceListId));

    const itemByPax = new Map<PaxType, (typeof itemRows)[number]>();
    for (const row of itemRows) {
      itemByPax.set(row.paxType as PaxType, row);
    }

    const requestedPairs: ReadonlyArray<{ readonly paxType: PaxType; readonly quantity: number }> =
      [
        { paxType: 'adult', quantity: paxValidation.adult },
        { paxType: 'child', quantity: paxValidation.child },
        { paxType: 'infant', quantity: paxValidation.infant },
      ];

    const lines: QuoteLineDto[] = [];
    const lineMonies: Money[] = [];
    let seats = 0;

    for (const reqPax of requestedPairs) {
      if (reqPax.quantity === 0) {
        continue;
      }
      const item = itemByPax.get(reqPax.paxType);
      if (!item) {
        return {
          ok: false,
          code: 'pax_type_not_offered',
          i18nKey: 'pricing.quote.paxTypeNotOffered',
          i18nParams: { paxType: reqPax.paxType },
          message: `Passenger type "${reqPax.paxType}" is not offered on this price list.`,
        };
      }

      const unitMoney = createMoney(item.amountMinor, currencyRaw);
      const lineMoney = multiplyByInt(unitMoney, BigInt(reqPax.quantity));
      lineMonies.push(lineMoney);

      lines.push({
        paxType: reqPax.paxType,
        quantity: reqPax.quantity,
        unitAmountMinor: unitMoney.amountMinor.toString(),
        lineAmountMinor: lineMoney.amountMinor.toString(),
      });

      if (item.occupiesSeat) {
        seats += reqPax.quantity;
      }
    }

    const totalMoney = sum(lineMonies, currencyRaw);

    const policyRes = await this.db.execute(sql`
      SELECT id, version, rules, weather_clause AS "weatherClause"
      FROM pricing.cancellation_policies
      WHERE product_id = ${departure.productId}::uuid
      ORDER BY version DESC
      LIMIT 1
    `);
    const policyRow = policyRes.rows[0];
    if (!policyRow) {
      return {
        ok: false,
        code: 'no_policy',
        i18nKey: 'pricing.quote.noPolicy',
        message: 'No cancellation policy is configured for this product.',
      };
    }

    const cancellationPolicyId = String(policyRow['id']);
    const cancellationPolicyVersion =
      typeof policyRow['version'] === 'number'
        ? policyRow['version']
        : Number.parseInt(String(policyRow['version']), 10);
    const rules = policyRow['rules'] as CancellationRule[];
    const weatherClause =
      typeof policyRow['weatherClause'] === 'string' ? policyRow['weatherClause'] : null;

    const clockRes = await this.db.execute(sql`SELECT now() AS "quotedAt"`);
    const quotedAt = toIsoTimestamp((clockRes.rows[0] as Record<string, unknown>)['quotedAt']);

    const corePayload = {
      productId: departure.productId,
      departureId: departure.id,
      startsAt: departure.startsAt,
      localDate: departure.localDate,
      currency: currencyRaw,
      lines,
      totalAmountMinor: totalMoney.amountMinor.toString(),
      seats,
      priceListId,
      priceListVersion,
      cancellationPolicyId,
      cancellationPolicyVersion,
      rules,
      weatherClause,
    };

    const snapshotHash = computeSnapshotHash(corePayload);

    return {
      ok: true,
      snapshot: {
        ...corePayload,
        quotedAt,
        snapshotHash,
      },
    };
  }

  async getPublicQuote(
    productId: string,
    query: {
      readonly departureId?: string;
      readonly adult?: string;
      readonly child?: string;
      readonly infant?: string;
      readonly locale?: string;
      readonly acceptLanguage?: string | string[];
    },
  ): Promise<{ readonly locale: string; readonly data: PublicQuoteResponse }> {
    const resolvedLocale = this.localeService.resolveLocale(query.locale, query.acceptLanguage);

    if (!UUID_REGEX.test(productId) || !query.departureId || !UUID_REGEX.test(query.departureId)) {
      throw catalogProductNotFoundException();
    }

    const visibility = await this.catalogService.getPublicProductVisibility(productId);
    if (!visibility.visible) {
      throw catalogProductNotFoundException();
    }

    const departure = await this.inventoryService.getDepartureQuoteTarget(query.departureId);
    if (!departure || departure.productId !== productId || !departure.isBookableNow) {
      throw pricingDepartureNotFoundException();
    }

    const adult = parseNonNegIntParam(query.adult, 'adult');
    const child = query.child !== undefined ? parseNonNegIntParam(query.child, 'child') : 0;
    const infant = query.infant !== undefined ? parseNonNegIntParam(query.infant, 'infant') : 0;

    const result = await this.quote({
      departureId: departure.id,
      pax: { adult, child, infant },
    });

    if (!result.ok) {
      if (result.code === 'departure_not_found') {
        throw pricingDepartureNotFoundException();
      }
      throw new UnprocessableEntityException({
        message: result.message,
        i18nKey: result.i18nKey,
        ...(result.i18nParams ? { i18nParams: result.i18nParams } : {}),
        errorCode: result.code,
      });
    }

    const s = result.snapshot;
    const publicLines: PublicQuoteLineDto[] = s.lines.map((line) => ({
      paxType: line.paxType,
      quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor,
      unitFormatted: formatMoney(
        createMoney(BigInt(line.unitAmountMinor), s.currency),
        resolvedLocale,
      ),
      lineAmountMinor: line.lineAmountMinor,
      lineFormatted: formatMoney(
        createMoney(BigInt(line.lineAmountMinor), s.currency),
        resolvedLocale,
      ),
    }));

    const totalFormatted = formatMoney(
      createMoney(BigInt(s.totalAmountMinor), s.currency),
      resolvedLocale,
    );

    const priceListItems = await this.db
      .select({
        paxType: pricingPriceListItems.paxType,
        minAge: pricingPriceListItems.minAge,
        maxAge: pricingPriceListItems.maxAge,
        occupiesSeat: pricingPriceListItems.occupiesSeat,
      })
      .from(pricingPriceListItems)
      .where(eq(pricingPriceListItems.priceListId, s.priceListId));

    const paxOrder: Readonly<Record<PaxType, number>> = { adult: 0, child: 1, infant: 2 };
    const ageBands: PublicPaxAgeBandDto[] = priceListItems
      .map((item) => ({
        paxType: item.paxType as PaxType,
        minAge: item.minAge,
        maxAge: item.maxAge,
        occupiesSeat: item.occupiesSeat,
      }))
      .sort((a, b) => paxOrder[a.paxType] - paxOrder[b.paxType]);

    return {
      locale: resolvedLocale,
      data: {
        productId: s.productId,
        departureId: s.departureId,
        startsAt: s.startsAt,
        localDate: s.localDate,
        locale: resolvedLocale,
        currency: s.currency,
        lines: publicLines,
        ageBands,
        totalAmountMinor: s.totalAmountMinor,
        totalFormatted,
        seats: s.seats,
        priceListVersion: s.priceListVersion,
        cancellationPolicyVersion: s.cancellationPolicyVersion,
        rules: s.rules,
        weatherClause: s.weatherClause,
        quotedAt: s.quotedAt,
        snapshotHash: s.snapshotHash,
      },
    };
  }

  async getPublicProductSummaryPricing(
    productId: string,
    timeZone: string,
    locale: string,
  ): Promise<PublicProductPricingSummary> {
    if (!UUID_REGEX.test(productId)) {
      return { fromPrice: null, cancellationSummary: null };
    }

    const dates = await this.inventoryService.getUpcomingOpenDepartureDates(
      productId,
      timeZone,
      62,
    );
    let fromPrice: PublicFromPriceDto | null = null;

    if (dates.length > 0) {
      const res = await this.db.execute(sql`
        SELECT
          pl.currency AS "currency",
          pli.amount_minor::text AS "amountMinor"
        FROM jsonb_array_elements_text(${JSON.stringify(dates)}::jsonb) AS d(local_date)
        CROSS JOIN LATERAL (
          SELECT id, currency
          FROM pricing.price_lists
          WHERE product_id = ${productId}::uuid
            AND valid_from <= d.local_date::date
            AND (valid_to IS NULL OR valid_to >= d.local_date::date)
          ORDER BY version DESC
          LIMIT 1
        ) pl
        INNER JOIN pricing.price_list_items pli
          ON pli.price_list_id = pl.id AND pli.pax_type = 'adult'
        ORDER BY pli.amount_minor ASC
        LIMIT 1
      `);
      const minRow = res.rows[0];
      if (minRow) {
        const currencyRaw = String(minRow['currency']).trim();
        assertSupportedCurrency(currencyRaw);
        const minMinor = BigInt(String(minRow['amountMinor']));
        fromPrice = {
          currency: currencyRaw,
          amountMinor: minMinor.toString(),
          formatted: formatMoney(createMoney(minMinor, currencyRaw), locale),
        };
      }
    }

    const policyRes = await this.db.execute(sql`
      SELECT version, rules, weather_clause AS "weatherClause"
      FROM pricing.cancellation_policies
      WHERE product_id = ${productId}::uuid
      ORDER BY version DESC
      LIMIT 1
    `);
    const policyRow = policyRes.rows[0];
    let cancellationSummary: PublicCancellationSummaryDto | null = null;
    if (policyRow) {
      const version =
        typeof policyRow['version'] === 'number'
          ? policyRow['version']
          : Number.parseInt(String(policyRow['version']), 10);
      cancellationSummary = {
        version,
        rules: policyRow['rules'] as CancellationRule[],
        weatherClause:
          typeof policyRow['weatherClause'] === 'string' ? policyRow['weatherClause'] : null,
      };
    }

    return {
      fromPrice,
      cancellationSummary,
    };
  }

  async getPublicProductsFromPrices(
    products: readonly { readonly id: string; readonly timeZone: string }[],
    locale: string,
  ): Promise<ReadonlyMap<string, PublicFromPriceDto | null>> {
    const result = new Map<string, PublicFromPriceDto | null>();
    if (products.length === 0) {
      return result;
    }
    for (const p of products) {
      result.set(p.id, null);
    }

    const datesByProduct = await this.inventoryService.getUpcomingOpenDepartureDatesBatch(
      products,
      62,
    );
    const pairs: Array<{ productId: string; localDate: string }> = [];
    for (const [productId, dates] of datesByProduct.entries()) {
      for (const localDate of dates) {
        pairs.push({ productId, localDate });
      }
    }
    if (pairs.length === 0) {
      return result;
    }

    const res = await this.db.execute(sql`
      SELECT
        sub."productId" AS "productId",
        (ARRAY_AGG(sub."currency" ORDER BY sub."amountMinor" ASC))[1] AS "currency",
        MIN(sub."amountMinor")::text AS "amountMinor"
      FROM (
        SELECT
          pair."productId"::text AS "productId",
          pl.currency AS "currency",
          pli.amount_minor AS "amountMinor"
        FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS pair("productId" uuid, "localDate" date)
        CROSS JOIN LATERAL (
          SELECT id, currency
          FROM pricing.price_lists
          WHERE product_id = pair."productId"
            AND valid_from <= pair."localDate"
            AND (valid_to IS NULL OR valid_to >= pair."localDate")
          ORDER BY version DESC
          LIMIT 1
        ) pl
        INNER JOIN pricing.price_list_items pli
          ON pli.price_list_id = pl.id AND pli.pax_type = 'adult'
      ) sub
      GROUP BY sub."productId"
    `);

    for (const row of res.rows) {
      const productId = String(row['productId']);
      const currencyRaw = String(row['currency']).trim();
      assertSupportedCurrency(currencyRaw);
      const minMinor = BigInt(String(row['amountMinor']));
      result.set(productId, {
        currency: currencyRaw,
        amountMinor: minMinor.toString(),
        formatted: formatMoney(createMoney(minMinor, currencyRaw), locale),
      });
    }

    return result;
  }
}
