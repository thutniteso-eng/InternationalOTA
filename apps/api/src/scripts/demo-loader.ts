import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PaxType, ProductKind } from '@internationalota/db';
import { resolveAppEnv } from '@internationalota/shared';
import { addDays, assertValidTimeZone, toLocalDateTime } from '@internationalota/time';
import {
  CatalogService,
  type AdminCatalogProductDto,
  type UpsertTranslationInput,
} from '../modules/catalog/index.js';
import { InventoryService } from '../modules/inventory/index.js';
import {
  PricingService,
  type CancellationRule,
  type PriceListItemDto,
  type PriceListItemInput,
} from '../modules/pricing/index.js';
import { SupplyService, type SupplierRecord } from '../modules/supply/index.js';

export interface DemoSupplierJson {
  readonly key: string;
  readonly name: string;
  readonly countryAlpha2: string;
  readonly status?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
}

export interface DemoTranslationJson {
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly description: string;
  readonly highlights?: readonly string[];
  readonly inclusions?: readonly string[];
  readonly exclusions?: readonly string[];
}

export interface DemoPerPersonPricingJson {
  readonly currency: string;
  readonly perPerson: Partial<Record<PaxType, number>>;
  readonly ageBands: Partial<Record<PaxType, string>>;
}

export interface DemoPerVehiclePricingJson {
  readonly currency: string;
  readonly perVehicle: Record<string, number>;
}

export interface DemoCancellationPolicyJson {
  readonly rules: readonly CancellationRule[];
  readonly weatherCancellationBySupplier?: string;
  readonly flightDelayPolicy?: string;
}

export interface DemoProductJson {
  readonly key: string;
  readonly supplier: string;
  readonly kind: ProductKind;
  readonly region: string;
  readonly location: { readonly lat: number; readonly lng: number };
  readonly meetingPoint: string;
  readonly durationMinutes: number;
  readonly departureTimes: readonly string[];
  readonly operatingDays: string | readonly number[];
  readonly capacityPerDeparture: number;
  readonly minPax?: number;
  readonly pricing: DemoPerPersonPricingJson | DemoPerVehiclePricingJson;
  readonly cancellationPolicy: DemoCancellationPolicyJson;
  readonly translations: Record<'vi' | 'en', DemoTranslationJson>;
}

export interface DemoCatalogJson {
  readonly _meta: {
    readonly timeZone: string;
  };
  readonly suppliers: readonly DemoSupplierJson[];
  readonly products: readonly DemoProductJson[];
}

export interface DemoLoaderServices {
  readonly supplyService: SupplyService;
  readonly catalogService: CatalogService;
  readonly inventoryService: InventoryService;
  readonly pricingService: PricingService;
}

export interface DemoLoaderResult {
  readonly suppliersCreated: number;
  readonly suppliersReused: number;
  readonly productsCreated: number;
  readonly productsPublished: number;
  readonly productsDraftKept: number;
  readonly translationsUpserted: number;
  readonly priceListsCreated: number;
  readonly priceListsReused: number;
  readonly policiesCreated: number;
  readonly policiesReused: number;
  readonly departuresCreated: number;
  readonly departuresSkipped: number;
  readonly notes: readonly string[];
}

const DEFAULT_BOOKING_CUTOFF_MINUTES = 60;
const DEPARTURE_WINDOW_EXTRA_DAYS = 60;
const DEMO_CREATED_BY = 'demo-loader';
const LOCAL_TIME_24H_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function assertDemoEnvAllowed(): 'local' | 'test' | 'staging' {
  const appEnv = resolveAppEnv();
  if (appEnv === 'production') {
    throw new Error('Refusing to run demo:load in production (APP_ENV=production).');
  }
  return appEnv;
}

export function resolveDemoCatalogPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return resolve(explicitPath);
  }
  return resolve(
    import.meta.dirname,
    '../../../../implementation/demo-data/phu-quoc-demo-catalog.json',
  );
}

export function parseAgeBand(band: string): { minAge: number; maxAge: number | null } {
  const trimmed = band.trim();
  const plusMatch = /^(\d+)\+$/.exec(trimmed);
  if (plusMatch) {
    return {
      minAge: Number.parseInt(plusMatch[1]!, 10),
      maxAge: null,
    };
  }
  const rangeMatch = /^(\d+)-(\d+)$/.exec(trimmed);
  if (rangeMatch) {
    const minAge = Number.parseInt(rangeMatch[1]!, 10);
    const maxAge = Number.parseInt(rangeMatch[2]!, 10);
    if (maxAge < minAge) {
      throw new Error(`Invalid age band range "${band}": maxAge < minAge.`);
    }
    return { minAge, maxAge };
  }
  throw new Error(`Unsupported age band format "${band}". Expected "N+" or "N-M".`);
}

function resolveOperatingWeekdays(operatingDays: string | readonly number[]): readonly number[] {
  if (operatingDays === 'daily') {
    return [1, 2, 3, 4, 5, 6, 7];
  }
  if (Array.isArray(operatingDays)) {
    return operatingDays.map((day) => Number(day));
  }
  throw new Error(`Unsupported operatingDays value "${String(operatingDays)}".`);
}

function isPerPersonPricing(
  pricing: DemoPerPersonPricingJson | DemoPerVehiclePricingJson,
): pricing is DemoPerPersonPricingJson {
  return 'perPerson' in pricing && 'ageBands' in pricing;
}

function normalizePriceListItemsForCompare(
  items: readonly Pick<
    PriceListItemDto,
    'paxType' | 'amountMinor' | 'minAge' | 'maxAge' | 'occupiesSeat'
  >[],
): string {
  const canonical = [...items]
    .sort((a, b) => a.paxType.localeCompare(b.paxType))
    .map((item) => ({
      paxType: item.paxType,
      amountMinor: item.amountMinor,
      minAge: item.minAge,
      maxAge: item.maxAge,
      occupiesSeat: item.occupiesSeat,
    }));
  return JSON.stringify(canonical);
}

function normalizeRulesForCompare(rules: readonly CancellationRule[]): string {
  return JSON.stringify(
    [...rules]
      .sort((a, b) => b.hoursBeforeStart - a.hoursBeforeStart)
      .map((rule) => ({
        hoursBeforeStart: rule.hoursBeforeStart,
        refundPercent: rule.refundPercent,
      })),
  );
}

function translationMatches(
  existing: AdminCatalogProductDto['translations'],
  locale: 'vi' | 'en',
  expected: UpsertTranslationInput,
): boolean {
  const current = existing?.find((tr) => tr.locale === locale);
  if (!current) {
    return false;
  }
  return (
    current.title === expected.title &&
    current.slug === expected.slug &&
    current.summary === expected.summary &&
    current.description === expected.description &&
    JSON.stringify(current.highlights) === JSON.stringify(expected.highlights ?? []) &&
    JSON.stringify(current.inclusions) === JSON.stringify(expected.inclusions ?? []) &&
    JSON.stringify(current.exclusions) === JSON.stringify(expected.exclusions ?? [])
  );
}

function buildDemoPriceListItems(pricing: DemoPerPersonPricingJson): PriceListItemInput[] {
  const paxOrder: readonly PaxType[] = ['adult', 'child', 'infant'];
  const items: PriceListItemInput[] = [];

  for (const paxType of paxOrder) {
    const rawAmount = pricing.perPerson[paxType];
    if (rawAmount === undefined) {
      continue;
    }
    const band = pricing.ageBands[paxType];
    if (!band) {
      throw new Error(`Missing ageBands entry for paxType "${paxType}".`);
    }
    const { minAge, maxAge } = parseAgeBand(band);
    items.push({
      paxType,
      amountMinor: BigInt(rawAmount),
      minAge,
      maxAge,
      occupiesSeat: paxType !== 'infant',
    });
  }

  return items;
}

function todayInTimeZone(timeZone: string, referenceNow: Date): string {
  return toLocalDateTime(referenceNow.toISOString(), timeZone).slice(0, 10);
}

export async function loadDemoCatalogFromFile(
  filePath = resolveDemoCatalogPath(),
): Promise<DemoCatalogJson> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as DemoCatalogJson;
}

export function validateDemoCatalogJson(catalog: DemoCatalogJson): void {
  if (!catalog._meta?.timeZone) {
    throw new Error('Demo catalog _meta.timeZone is required.');
  }
  assertValidTimeZone(catalog._meta.timeZone);

  for (const sup of catalog.suppliers) {
    if (!sup.name.includes('(Demo)')) {
      throw new Error(`Refusing demo supplier "${sup.name}": supplier name must contain "(Demo)".`);
    }
  }
}

export async function runDemoLoader(
  services: DemoLoaderServices,
  options: {
    readonly catalog?: DemoCatalogJson;
    readonly catalogPath?: string;
    readonly now?: Date;
    readonly log?: (line: string) => void;
  } = {},
): Promise<DemoLoaderResult> {
  assertDemoEnvAllowed();
  const catalog = options.catalog ?? (await loadDemoCatalogFromFile(options.catalogPath));
  validateDemoCatalogJson(catalog);

  const timeZone = catalog._meta.timeZone;
  const referenceNow = options.now ?? new Date();
  const todayLocal = todayInTimeZone(timeZone, referenceNow);
  const windowEndLocal = addDays(todayLocal, DEPARTURE_WINDOW_EXTRA_DAYS);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const notes: string[] = [];
  let suppliersCreated = 0;
  let suppliersReused = 0;
  let productsCreated = 0;
  let productsPublished = 0;
  let productsDraftKept = 0;
  let translationsUpserted = 0;
  let priceListsCreated = 0;
  let priceListsReused = 0;
  let policiesCreated = 0;
  let policiesReused = 0;
  let departuresCreated = 0;
  let departuresSkipped = 0;

  // 1. Upsert/find demo suppliers by stable name
  const existingSuppliers = await services.supplyService.listSuppliers({ limit: 100 });
  const supplierByName = new Map<string, SupplierRecord>(
    existingSuppliers.map((sup) => [sup.name, sup]),
  );
  const supplierByKey = new Map<string, SupplierRecord>();

  for (const supJson of catalog.suppliers) {
    let record = supplierByName.get(supJson.name);
    if (!record) {
      record = await services.supplyService.createSupplier({
        name: supJson.name,
        countryAlpha2: supJson.countryAlpha2,
        contactEmail: supJson.contactEmail ?? null,
        contactPhone: supJson.contactPhone ?? null,
      });
      if (supJson.status === 'suspended') {
        record = await services.supplyService.setSupplierStatus(record.id, 'suspended');
      }
      supplierByName.set(record.name, record);
      suppliersCreated += 1;
    } else {
      suppliersReused += 1;
    }
    supplierByKey.set(supJson.key, record);
  }

  // 2. Index existing products belonging to demo suppliers by vi slug
  const productByViSlug = new Map<string, AdminCatalogProductDto>();
  for (const sup of supplierByKey.values()) {
    const listed = await services.catalogService.listAdminProducts({
      supplierId: sup.id,
      limit: 100,
    });
    const details = await Promise.all(
      listed.items.map((item) => services.catalogService.getAdminProductById(item.id)),
    );
    for (const detail of details) {
      const viTrans = detail.translations?.find((tr) => tr.locale === 'vi');
      if (viTrans) {
        productByViSlug.set(viTrans.slug, detail);
      }
    }
  }

  // 3. Ensure products, translations, publishing, pricing, policy, departures
  for (const prodJson of catalog.products) {
    const supplier = supplierByKey.get(prodJson.supplier);
    if (!supplier) {
      throw new Error(`Unknown supplier key "${prodJson.supplier}" on product "${prodJson.key}".`);
    }

    const viSlug = prodJson.translations.vi.slug;
    let product = productByViSlug.get(viSlug);
    if (!product) {
      product = await services.catalogService.createProduct({
        supplierId: supplier.id,
        kind: prodJson.kind,
        countryAlpha2: supplier.countryAlpha2,
        region: prodJson.region,
        location: prodJson.location,
        meetingPointNote: prodJson.meetingPoint,
        timeZone,
        durationMinutes: prodJson.durationMinutes,
      });
      productsCreated += 1;
    }

    for (const locale of ['vi', 'en'] as const) {
      const tr = prodJson.translations[locale];
      const expectedInput: UpsertTranslationInput = {
        title: tr.title,
        slug: tr.slug,
        summary: tr.summary,
        description: tr.description,
        highlights: tr.highlights ?? [],
        inclusions: tr.inclusions ?? [],
        exclusions: tr.exclusions ?? [],
      };
      if (!translationMatches(product.translations, locale, expectedInput)) {
        await services.catalogService.upsertTranslation(product.id, locale, expectedInput);
        translationsUpserted += 1;
      }
    }

    // Transfers use per-vehicle pricing and on-request departures (not modelled yet): keep as draft
    if (prodJson.kind === 'transfer' || !isPerPersonPricing(prodJson.pricing)) {
      const msg = `[demo:load] keeping transfer product "${viSlug}" as draft (per-vehicle pricing and on-request departures are not modelled yet).`;
      log(msg);
      notes.push(msg);
      productsDraftKept += 1;
      continue;
    }

    if (product.status !== 'published') {
      product = await services.catalogService.publishProduct(product.id);
      productsPublished += 1;
    }

    // Price list (create v1 if absent or if currency/items changed compared to latest version)
    const desiredItems = buildDemoPriceListItems(prodJson.pricing);
    const desiredItemsComparable = normalizePriceListItemsForCompare(
      desiredItems.map((it) => ({
        paxType: it.paxType,
        amountMinor: BigInt(it.amountMinor).toString(),
        minAge: it.minAge,
        maxAge: it.maxAge ?? null,
        occupiesSeat: it.occupiesSeat,
      })),
    );
    const existingPriceLists = await services.pricingService.listPriceLists(product.id);
    const latestPriceList = existingPriceLists.items[0];
    if (
      latestPriceList &&
      latestPriceList.currency === prodJson.pricing.currency &&
      normalizePriceListItemsForCompare(latestPriceList.items) === desiredItemsComparable
    ) {
      priceListsReused += 1;
    } else {
      await services.pricingService.createPriceList(
        product.id,
        {
          currency: prodJson.pricing.currency,
          validFrom: todayLocal,
          validTo: null,
          items: desiredItems,
        },
        DEMO_CREATED_BY,
      );
      priceListsCreated += 1;
    }

    // Cancellation policy
    const desiredWeatherClause = prodJson.cancellationPolicy.weatherCancellationBySupplier ?? null;
    const desiredRulesComparable = normalizeRulesForCompare(prodJson.cancellationPolicy.rules);
    const existingPolicies = await services.pricingService.listCancellationPolicies(product.id);
    const latestPolicy = existingPolicies.items[0];
    if (
      latestPolicy &&
      normalizeRulesForCompare(latestPolicy.rules) === desiredRulesComparable &&
      (latestPolicy.weatherClause ?? null) === desiredWeatherClause
    ) {
      policiesReused += 1;
    } else {
      await services.pricingService.createCancellationPolicy(product.id, {
        rules: prodJson.cancellationPolicy.rules,
        weatherClause: desiredWeatherClause,
      });
      policiesCreated += 1;
    }

    // Departures: rolling window today .. today + 60 days (61 days inclusive)
    const departureTimes = prodJson.departureTimes.filter((t) => LOCAL_TIME_24H_REGEX.test(t));
    if (departureTimes.length > 0) {
      const genResult = await services.inventoryService.generateDepartures(product.id, {
        fromDate: todayLocal,
        toDate: windowEndLocal,
        weekdays: resolveOperatingWeekdays(prodJson.operatingDays),
        localTimes: departureTimes,
        capacity: prodJson.capacityPerDeparture,
        bookingCutoffMinutes: DEFAULT_BOOKING_CUTOFF_MINUTES,
      });
      departuresCreated += genResult.createdCount;
      departuresSkipped += genResult.skippedCount;
    }
  }

  return {
    suppliersCreated,
    suppliersReused,
    productsCreated,
    productsPublished,
    productsDraftKept,
    translationsUpserted,
    priceListsCreated,
    priceListsReused,
    policiesCreated,
    policiesReused,
    departuresCreated,
    departuresSkipped,
    notes,
  };
}
