import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbClient, type DatabaseClient } from './client.ts';
import { countries, currencies, languages, timeZones } from './schema/reference.ts';

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

  // Execute in order respecting foreign keys:
  // 1. Countries
  if (countriesData.length > 0) {
    await db.insert(countries).values(countriesData).onConflictDoNothing();
  }

  // 2. Currencies
  if (currenciesData.length > 0) {
    await db.insert(currencies).values(currenciesData).onConflictDoNothing();
  }

  // 3. Languages
  if (languagesData.length > 0) {
    await db.insert(languages).values(languagesData).onConflictDoNothing();
  }

  // 4. Time zones (foreign key to countries)
  if (timeZonesData.length > 0) {
    // Insert in chunks of 200 if needed for parameter safety
    const chunkSize = 200;
    for (let i = 0; i < timeZonesData.length; i += chunkSize) {
      const chunk = timeZonesData.slice(i, i + chunkSize);
      await db.insert(timeZones).values(chunk).onConflictDoNothing();
    }
  }

  return {
    countries: countriesData.length,
    currencies: currenciesData.length,
    languages: languagesData.length,
    timeZones: timeZonesData.length,
  };
}

export async function runSeedCli(): Promise<void> {
  try {
    const { db, pool } = createDbClient();
    try {
      console.log('Seeding reference data...');
      const result = await seedReferenceData(db);
      console.log(
        `Reference data seeded successfully: ${result.countries} countries, ${result.currencies} currencies, ${result.languages} languages, ${result.timeZones} time zones.`,
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
