import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDbClient, type DatabaseClient } from './client.ts';
import { financeAccounts } from './schema/finance.ts';
import { countries, currencies, languages, timeZones } from './schema/reference.ts';

export const DEFAULT_CHART_OF_ACCOUNTS = [
  // VND accounts
  { code: 'psp_clearing_vnd', name: 'PSP Clearing (VND)', type: 'asset', currency: 'VND' },
  {
    code: 'customer_deposits_vnd',
    name: 'Customer Deposits (VND)',
    type: 'liability',
    currency: 'VND',
  },
  {
    code: 'supplier_payables_vnd',
    name: 'Supplier Payables (VND)',
    type: 'liability',
    currency: 'VND',
  },
  {
    code: 'commission_revenue_vnd',
    name: 'Commission Revenue (VND)',
    type: 'revenue',
    currency: 'VND',
  },
  { code: 'psp_fees_vnd', name: 'PSP Fees (VND)', type: 'expense', currency: 'VND' },
  // USD accounts
  { code: 'psp_clearing_usd', name: 'PSP Clearing (USD)', type: 'asset', currency: 'USD' },
  {
    code: 'customer_deposits_usd',
    name: 'Customer Deposits (USD)',
    type: 'liability',
    currency: 'USD',
  },
  {
    code: 'supplier_payables_usd',
    name: 'Supplier Payables (USD)',
    type: 'liability',
    currency: 'USD',
  },
  {
    code: 'commission_revenue_usd',
    name: 'Commission Revenue (USD)',
    type: 'revenue',
    currency: 'USD',
  },
  { code: 'psp_fees_usd', name: 'PSP Fees (USD)', type: 'expense', currency: 'USD' },
] as const;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getReferenceDataFolder(): string {
  return resolve(__dirname, '../reference-data');
}

export interface SeedResult {
  countries: number;
  currencies: number;
  languages: number;
  timeZones: number;
  accounts: number;
}

interface CountryJson {
  alpha2: string;
  alpha3: string;
  numeric: string;
  nameEn: string;
}

interface CurrencyJson {
  code: string;
  numeric: string | null;
  minorUnits: number | null;
  nameEn: string;
  enabledForSale: boolean;
}

interface LanguageJson {
  tag: string;
  nameEn: string;
  nameNative: string;
  enabled: boolean;
}

interface TimeZoneJson {
  name: string;
  countryAlpha2: string | null;
}

/**
 * Seeds reference data into the database from JSON files.
 *
 * Implements an atomic upsert inside a single transaction (F1, F2):
 * - Existing rows whose values have changed are updated, and their updated_at timestamp is set to now().
 * - Existing rows whose values are identical are not updated (via IS DISTINCT FROM), preserving their original updated_at.
 * - New rows are inserted.
 * - Rows removed from the JSON files are NOT deleted from the database.
 */
export async function seedReferenceData(
  db: DatabaseClient,
  dataFolder = getReferenceDataFolder(),
): Promise<SeedResult> {
  const countriesData = JSON.parse(
    readFileSync(resolve(dataFolder, 'countries.json'), 'utf8'),
  ) as CountryJson[];
  const currenciesData = JSON.parse(
    readFileSync(resolve(dataFolder, 'currencies.json'), 'utf8'),
  ) as CurrencyJson[];
  const languagesData = JSON.parse(
    readFileSync(resolve(dataFolder, 'languages.json'), 'utf8'),
  ) as LanguageJson[];
  const timeZonesData = JSON.parse(
    readFileSync(resolve(dataFolder, 'time-zones.json'), 'utf8'),
  ) as TimeZoneJson[];

  return await db.transaction(async (tx) => {
    // 1. Countries
    if (countriesData.length > 0) {
      await tx
        .insert(countries)
        .values(countriesData)
        .onConflictDoUpdate({
          target: countries.alpha2,
          set: {
            alpha3: sql`excluded.alpha3`,
            numeric: sql`excluded.numeric`,
            nameEn: sql`excluded.name_en`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`(${countries.alpha3}, ${countries.numeric}, ${countries.nameEn}) IS DISTINCT FROM (excluded.alpha3, excluded.numeric, excluded.name_en)`,
        });
    }

    // 2. Currencies
    if (currenciesData.length > 0) {
      await tx
        .insert(currencies)
        .values(currenciesData)
        .onConflictDoUpdate({
          target: currencies.code,
          set: {
            numeric: sql`excluded.numeric`,
            minorUnits: sql`excluded.minor_units`,
            nameEn: sql`excluded.name_en`,
            enabledForSale: sql`excluded.enabled_for_sale`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`(${currencies.numeric}, ${currencies.minorUnits}, ${currencies.nameEn}, ${currencies.enabledForSale}) IS DISTINCT FROM (excluded.numeric, excluded.minor_units, excluded.name_en, excluded.enabled_for_sale)`,
        });
    }

    // 3. Languages
    if (languagesData.length > 0) {
      await tx
        .insert(languages)
        .values(languagesData)
        .onConflictDoUpdate({
          target: languages.tag,
          set: {
            nameEn: sql`excluded.name_en`,
            nameNative: sql`excluded.name_native`,
            enabled: sql`excluded.enabled`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`(${languages.nameEn}, ${languages.nameNative}, ${languages.enabled}) IS DISTINCT FROM (excluded.name_en, excluded.name_native, excluded.enabled)`,
        });
    }

    // 4. Time zones (foreign key to countries)
    if (timeZonesData.length > 0) {
      // Insert in chunks of 200 for parameter safety
      const chunkSize = 200;
      for (let i = 0; i < timeZonesData.length; i += chunkSize) {
        const chunk = timeZonesData.slice(i, i + chunkSize);
        await tx
          .insert(timeZones)
          .values(chunk)
          .onConflictDoUpdate({
            target: timeZones.name,
            set: {
              countryAlpha2: sql`excluded.country_alpha2`,
              updatedAt: sql`now()`,
            },
            setWhere: sql`${timeZones.countryAlpha2} IS DISTINCT FROM excluded.country_alpha2`,
          });
      }
    }

    // 5. Minimal chart of accounts for VND and USD (P1-09, D-004 open)
    await tx
      .insert(financeAccounts)
      .values(
        DEFAULT_CHART_OF_ACCOUNTS.map((acct) => ({
          code: acct.code,
          name: acct.name,
          type: acct.type,
          currency: acct.currency,
          isActive: true,
        })),
      )
      .onConflictDoUpdate({
        target: financeAccounts.code,
        set: {
          name: sql`excluded.name`,
          type: sql`excluded.type`,
          currency: sql`excluded.currency`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`(${financeAccounts.name}, ${financeAccounts.type}, ${financeAccounts.currency}) IS DISTINCT FROM (excluded.name, excluded.type, excluded.currency)`,
      });

    return {
      countries: countriesData.length,
      currencies: currenciesData.length,
      languages: languagesData.length,
      timeZones: timeZonesData.length,
      accounts: DEFAULT_CHART_OF_ACCOUNTS.length,
    };
  });
}

export async function runSeedCli(): Promise<void> {
  try {
    const { db, pool } = createDbClient();
    try {
      console.log('Seeding reference data...');
      const result = await seedReferenceData(db);
      console.log(
        `Reference data seeded successfully: ${result.countries} countries, ${result.currencies} currencies, ${result.languages} languages, ${result.timeZones} time zones, ${result.accounts} ledger accounts.`,
      );
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error('Seeding failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runSeedCli();
}
