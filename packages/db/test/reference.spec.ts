import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPPORTED_CURRENCIES, type CurrencyCode } from '@internationalota/money';
import { isValidTimeZone, startOfLocalDayUtc } from '@internationalota/time';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countries, currencies, languages, timeZones } from '../src/schema/reference.ts';
import { getReferenceDataFolder, seedReferenceData } from '../src/seed.ts';
import { createTestDatabase, type TestDbInstance } from './test-db.ts';

describe('Reference data schema and seed integration tests', () => {
  let testDb: TestDbInstance;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await seedReferenceData(testDb.db);
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.teardown();
    }
  });

  describe('Row counts and seed data integrity', () => {
    it('populates expected counts in all reference tables', async () => {
      const countryRows = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(countries);
      const currencyRows = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(currencies);
      const languageRows = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(languages);
      const timeZoneRows = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(timeZones);

      expect(countryRows[0]?.count).toBe(250);
      expect(currencyRows[0]?.count).toBe(179);
      expect(languageRows[0]?.count).toBe(5);
      expect(timeZoneRows[0]?.count).toBe(419);
    });

    it('spot checks countries: VN/VNM/704 and US/USA/840', async () => {
      const vn = await testDb.db.select().from(countries).where(eq(countries.alpha2, 'VN'));
      expect(vn).toHaveLength(1);
      expect(vn[0]?.alpha2).toBe('VN');
      expect(vn[0]?.alpha3).toBe('VNM');
      expect(vn[0]?.numeric).toBe('704');
      expect(vn[0]?.nameEn).toBe('Vietnam');

      const us = await testDb.db.select().from(countries).where(eq(countries.alpha2, 'US'));
      expect(us).toHaveLength(1);
      expect(us[0]?.alpha2).toBe('US');
      expect(us[0]?.alpha3).toBe('USA');
      expect(us[0]?.numeric).toBe('840');
      expect(us[0]?.nameEn).toBe('United States of America');
    });

    it('spot checks currencies: VND (0), USD (2), JPY (0), KWD (3)', async () => {
      const vnd = await testDb.db.select().from(currencies).where(eq(currencies.code, 'VND'));
      expect(vnd).toHaveLength(1);
      expect(vnd[0]?.numeric).toBe('704');
      expect(vnd[0]?.minorUnits).toBe(0);
      expect(vnd[0]?.enabledForSale).toBe(true);

      const usd = await testDb.db.select().from(currencies).where(eq(currencies.code, 'USD'));
      expect(usd).toHaveLength(1);
      expect(usd[0]?.numeric).toBe('840');
      expect(usd[0]?.minorUnits).toBe(2);
      expect(usd[0]?.enabledForSale).toBe(true);

      const jpy = await testDb.db.select().from(currencies).where(eq(currencies.code, 'JPY'));
      expect(jpy).toHaveLength(1);
      expect(jpy[0]?.numeric).toBe('392');
      expect(jpy[0]?.minorUnits).toBe(0);
      expect(jpy[0]?.enabledForSale).toBe(true);

      const kwd = await testDb.db.select().from(currencies).where(eq(currencies.code, 'KWD'));
      expect(kwd).toHaveLength(1);
      expect(kwd[0]?.numeric).toBe('414');
      expect(kwd[0]?.minorUnits).toBe(3);
      expect(kwd[0]?.enabledForSale).toBe(false);
    });

    it('spot checks languages: 5 total, 2 enabled (vi, en), 3 disabled (ko, zh-Hans, ja)', async () => {
      const allLangs = await testDb.db.select().from(languages);
      expect(allLangs).toHaveLength(5);

      const enabled = allLangs
        .filter((l) => l.enabled)
        .map((l) => l.tag)
        .sort();
      const disabled = allLangs
        .filter((l) => !l.enabled)
        .map((l) => l.tag)
        .sort();

      expect(enabled).toEqual(['en', 'vi']);
      expect(disabled).toEqual(['ja', 'ko', 'zh-Hans']);

      const vi = allLangs.find((l) => l.tag === 'vi');
      expect(vi?.nameEn).toBe('Vietnamese');
      expect(vi?.nameNative).toBe('Tiếng Việt');
    });

    it('spot checks time zones: Asia/Ho_Chi_Minh maps to VN, Asia/Saigon excluded, UTC null', async () => {
      const hcm = await testDb.db
        .select()
        .from(timeZones)
        .where(eq(timeZones.name, 'Asia/Ho_Chi_Minh'));
      expect(hcm).toHaveLength(1);
      expect(hcm[0]?.name).toBe('Asia/Ho_Chi_Minh');
      expect(hcm[0]?.countryAlpha2).toBe('VN');

      // Canonical table must NOT contain legacy CLDR alias Asia/Saigon
      const saigon = await testDb.db
        .select()
        .from(timeZones)
        .where(eq(timeZones.name, 'Asia/Saigon'));
      expect(saigon).toHaveLength(0);

      const utc = await testDb.db.select().from(timeZones).where(eq(timeZones.name, 'UTC'));
      expect(utc).toHaveLength(1);
      expect(utc[0]?.name).toBe('UTC');
      expect(utc[0]?.countryAlpha2).toBeNull();
    });

    it('records ISO 4217 "N.A." minor units as NULL for non-currency and bond codes (F3)', async () => {
      const naCodes = [
        'XAG',
        'XAU',
        'XBA',
        'XBB',
        'XBC',
        'XBD',
        'XDR',
        'XPD',
        'XPT',
        'XSU',
        'XTS',
        'XUA',
        'XXX',
      ];
      const naRows = await testDb.db
        .select()
        .from(currencies)
        .where(inArray(currencies.code, naCodes));

      expect(naRows).toHaveLength(naCodes.length);
      for (const row of naRows) {
        expect(row.minorUnits).toBeNull();
      }

      // Circulating fiat currencies with 0 minor units must remain 0
      const zeroCodes = ['XAF', 'XOF', 'XPF'];
      const zeroRows = await testDb.db
        .select()
        .from(currencies)
        .where(inArray(currencies.code, zeroCodes));
      expect(zeroRows).toHaveLength(3);
      for (const row of zeroRows) {
        expect(row.minorUnits).toBe(0);
      }
    });
  });

  describe('Seed idempotency', () => {
    it('running seed a second time leaves row counts and updated_at completely unchanged', async () => {
      // Capture row counts and updated_at before second seed
      const countryBefore = await testDb.db
        .select()
        .from(countries)
        .where(eq(countries.alpha2, 'VN'));
      const currencyBefore = await testDb.db
        .select()
        .from(currencies)
        .where(eq(currencies.code, 'VND'));
      const languageBefore = await testDb.db
        .select()
        .from(languages)
        .where(eq(languages.tag, 'vi'));
      const timeZoneBefore = await testDb.db
        .select()
        .from(timeZones)
        .where(eq(timeZones.name, 'Asia/Ho_Chi_Minh'));

      const vnCountryUpdatedAt = countryBefore[0]?.updatedAt;
      const vndCurrencyUpdatedAt = currencyBefore[0]?.updatedAt;
      const viLanguageUpdatedAt = languageBefore[0]?.updatedAt;
      const hcmTimeZoneUpdatedAt = timeZoneBefore[0]?.updatedAt;

      // Small delay to ensure any timestamp change would be observable
      await new Promise((r) => setTimeout(r, 100));

      // Re-run seed
      await seedReferenceData(testDb.db);

      // Verify counts remain identical
      const countryCount = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(countries);
      const currencyCount = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(currencies);
      const languageCount = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(languages);
      const timeZoneCount = await testDb.db
        .select({ count: sql<number>`count(*)::int` })
        .from(timeZones);

      expect(countryCount[0]?.count).toBe(250);
      expect(currencyCount[0]?.count).toBe(179);
      expect(languageCount[0]?.count).toBe(5);
      expect(timeZoneCount[0]?.count).toBe(419);

      // Verify updated_at is unchanged on existing rows
      const countryAfter = await testDb.db
        .select()
        .from(countries)
        .where(eq(countries.alpha2, 'VN'));
      const currencyAfter = await testDb.db
        .select()
        .from(currencies)
        .where(eq(currencies.code, 'VND'));
      const languageAfter = await testDb.db.select().from(languages).where(eq(languages.tag, 'vi'));
      const timeZoneAfter = await testDb.db
        .select()
        .from(timeZones)
        .where(eq(timeZones.name, 'Asia/Ho_Chi_Minh'));

      expect(countryAfter[0]?.updatedAt.getTime()).toBe(vnCountryUpdatedAt?.getTime());
      expect(currencyAfter[0]?.updatedAt.getTime()).toBe(vndCurrencyUpdatedAt?.getTime());
      expect(languageAfter[0]?.updatedAt.getTime()).toBe(viLanguageUpdatedAt?.getTime());
      expect(timeZoneAfter[0]?.updatedAt.getTime()).toBe(hcmTimeZoneUpdatedAt?.getTime());
    });

    it('upserts updated rows and advances updated_at while preserving unchanged rows and retained rows (F1)', async () => {
      // 1. Capture initial KWD and USD records
      const [kwdBefore] = await testDb.db
        .select()
        .from(currencies)
        .where(eq(currencies.code, 'KWD'));
      const [usdBefore] = await testDb.db
        .select()
        .from(currencies)
        .where(eq(currencies.code, 'USD'));

      expect(kwdBefore?.enabledForSale).toBe(false);
      expect(kwdBefore?.nameEn).toBe('Kuwaiti Dinar');
      expect(usdBefore?.enabledForSale).toBe(true);

      // 2. Create temporary folder containing modified reference JSON data
      const tempDir = mkdtempSync(join(tmpdir(), 'ota-ref-upsert-test-'));
      try {
        const canonicalDir = getReferenceDataFolder();
        // Copy countries, languages, time-zones unchanged
        copyFileSync(join(canonicalDir, 'countries.json'), join(tempDir, 'countries.json'));
        copyFileSync(join(canonicalDir, 'languages.json'), join(tempDir, 'languages.json'));
        copyFileSync(join(canonicalDir, 'time-zones.json'), join(tempDir, 'time-zones.json'));

        // Load currencies.json, modify KWD, and omit ZWL
        const currs = JSON.parse(
          readFileSync(join(canonicalDir, 'currencies.json'), 'utf8'),
        ) as Array<{
          code: string;
          numeric: string | null;
          minorUnits: number | null;
          nameEn: string;
          enabledForSale: boolean;
        }>;

        const kwdItem = currs.find((c) => c.code === 'KWD');
        expect(kwdItem).toBeDefined();
        if (kwdItem) {
          kwdItem.nameEn = 'Kuwaiti Dinar (Modified)';
          kwdItem.enabledForSale = true;
        }

        // Omit ZWG from the seed file to verify omitted rows are not deleted
        const filteredCurrs = currs.filter((c) => c.code !== 'ZWG');
        writeFileSync(join(tempDir, 'currencies.json'), JSON.stringify(filteredCurrs, null, 2));

        // Delay to ensure timestamp increment is detectable
        await new Promise((r) => setTimeout(r, 100));

        // 3. Re-run seed with modified dataset
        await seedReferenceData(testDb.db, tempDir);

        // 4. Verify KWD was updated and updated_at was advanced
        const [kwdAfter] = await testDb.db
          .select()
          .from(currencies)
          .where(eq(currencies.code, 'KWD'));
        expect(kwdAfter?.nameEn).toBe('Kuwaiti Dinar (Modified)');
        expect(kwdAfter?.enabledForSale).toBe(true);
        expect(kwdAfter?.updatedAt.getTime()).toBeGreaterThan(kwdBefore?.updatedAt.getTime() ?? 0);

        // 5. Verify USD was NOT updated and updated_at remains identical
        const [usdAfter] = await testDb.db
          .select()
          .from(currencies)
          .where(eq(currencies.code, 'USD'));
        expect(usdAfter?.nameEn).toBe(usdBefore?.nameEn);
        expect(usdAfter?.enabledForSale).toBe(usdBefore?.enabledForSale);
        expect(usdAfter?.updatedAt.getTime()).toBe(usdBefore?.updatedAt.getTime());

        // 6. Verify row omitted from JSON (ZWG) was NOT deleted
        const [zwg] = await testDb.db.select().from(currencies).where(eq(currencies.code, 'ZWG'));
        expect(zwg).toBeDefined();
        expect(zwg?.code).toBe('ZWG');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
        // Restore canonical seed state
        await seedReferenceData(testDb.db);
      }
    });
  });

  describe('Cross-package consistency', () => {
    it('every supported currency in @internationalota/money matches reference table and enabled_for_sale', async () => {
      const allCurrencies = await testDb.db.select().from(currencies);
      const saleEnabled = allCurrencies.filter((c) => c.enabledForSale);

      // Exactly the 10 currencies from SUPPORTED_CURRENCIES must be enabled
      const supportedCodes = Object.keys(SUPPORTED_CURRENCIES) as CurrencyCode[];
      expect(saleEnabled).toHaveLength(supportedCodes.length);

      for (const code of supportedCodes) {
        const expectedConfig = SUPPORTED_CURRENCIES[code];
        const dbCurrency = allCurrencies.find((c) => c.code === code);

        expect(dbCurrency).toBeDefined();
        expect(dbCurrency?.enabledForSale).toBe(true);
        expect(dbCurrency?.minorUnits).toBe(expectedConfig.exponent);
      }
    });

    it('Asia/Ho_Chi_Minh, Europe/Berlin, and UTC are valid and handled correctly by @internationalota/time', () => {
      expect(isValidTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
      expect(isValidTimeZone('Europe/Berlin')).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);

      // Vietnam is UTC+7 constant
      expect(startOfLocalDayUtc('2026-12-24', 'Asia/Ho_Chi_Minh')).toBe('2026-12-23T17:00:00Z');

      // Berlin spring forward DST (2026-03-29 midnight is 23:00 UTC previous day)
      expect(startOfLocalDayUtc('2026-03-29', 'Europe/Berlin')).toBe('2026-03-28T23:00:00Z');

      // UTC start of day is identical to UTC date
      expect(startOfLocalDayUtc('2026-12-24', 'UTC')).toBe('2026-12-24T00:00:00Z');
    });
  });
});
