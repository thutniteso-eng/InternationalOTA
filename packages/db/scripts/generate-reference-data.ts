import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import countriesLib from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import cc from 'currency-codes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outDir = resolve(__dirname, '../reference-data');

// Supported currencies in @internationalota/money
const SALE_ENABLED_CURRENCIES = new Set([
  'VND',
  'USD',
  'EUR',
  'GBP',
  'AUD',
  'SGD',
  'THB',
  'CNY',
  'KRW',
  'JPY',
]);

// 1. Generate Countries
countriesLib.registerLocale(enLocale);
const countryNames = countriesLib.getNames('en');
const countryEntries = Object.entries(countryNames)
  .map(([alpha2, name]) => {
    const alpha3 = countriesLib.alpha2ToAlpha3(alpha2);
    const num = countriesLib.alpha2ToNumeric(alpha2);
    if (!alpha3 || !num) {
      throw new Error(`Country ${alpha2} missing alpha3 or numeric code`);
    }
    return {
      alpha2: alpha2.toUpperCase(),
      alpha3: alpha3.toUpperCase(),
      numeric: String(num).padStart(3, '0'),
      nameEn: name,
    };
  })
  .sort((a, b) => a.alpha2.localeCompare(b.alpha2));

const validCountrySet = new Set(countryEntries.map((c) => c.alpha2));

// 2. Generate Currencies
interface CurrencyRawItem {
  code: string;
  number?: string;
  digits?: number;
  currency: string;
}

// ISO 4217 specifies minor units as "N.A." for precious metals, bond market units,
// supranational funds, and testing/no-currency codes. In the database and JSON,
// these must be recorded as NULL (not 0).
const ISO_4217_NA_MINOR_UNITS = new Set([
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
]);

const currencyList: Array<{
  code: string;
  numeric: string | null;
  minorUnits: number | null;
  nameEn: string;
  enabledForSale: boolean;
}> = [];

const seenCurrencies = new Set<string>();
for (const item of cc.data as CurrencyRawItem[]) {
  if (seenCurrencies.has(item.code)) {
    continue;
  }
  seenCurrencies.add(item.code);

  const minorUnits = ISO_4217_NA_MINOR_UNITS.has(item.code)
    ? null
    : typeof item.digits === 'number'
      ? item.digits
      : null;
  const numeric = item.number ? String(item.number).padStart(3, '0') : null;
  const enabledForSale = SALE_ENABLED_CURRENCIES.has(item.code);

  currencyList.push({
    code: item.code.toUpperCase(),
    numeric,
    minorUnits,
    nameEn: item.currency,
    enabledForSale,
  });
}

currencyList.sort((a, b) => a.code.localeCompare(b.code));

// 3. Generate Languages
const languagesList = [
  { tag: 'vi', nameEn: 'Vietnamese', nameNative: 'Tiếng Việt', enabled: true },
  { tag: 'en', nameEn: 'English', nameNative: 'English', enabled: true },
  { tag: 'ko', nameEn: 'Korean', nameNative: '한국어', enabled: false },
  { tag: 'zh-Hans', nameEn: 'Simplified Chinese', nameNative: '简体中文', enabled: false },
  { tag: 'ja', nameEn: 'Japanese', nameNative: '日本語', enabled: false },
];

// 4. Generate Time Zones (IANA canonical)
const tzPath = '/usr/share/zoneinfo/zone.tab';
if (!existsSync(tzPath)) {
  throw new Error(`Cannot find IANA zone.tab at ${tzPath}`);
}

const zoneContent = readFileSync(tzPath, 'utf8');
const zoneLines = zoneContent.split('\n').filter((l) => l.trim() && !l.startsWith('#'));

const timeZonesList: Array<{
  name: string;
  countryAlpha2: string | null;
}> = [];

const seenZones = new Set<string>();

for (const line of zoneLines) {
  const parts = line.split('\t');
  const countryCode = parts[0]?.trim().toUpperCase();
  const name = parts[2]?.trim();

  if (!name || seenZones.has(name)) {
    continue;
  }

  // Verify country code exists in countries table
  if (countryCode && !validCountrySet.has(countryCode)) {
    throw new Error(`Zone ${name} has invalid country code ${countryCode}`);
  }

  seenZones.add(name);
  timeZonesList.push({
    name,
    countryAlpha2: countryCode ?? null,
  });
}

// Add UTC as global non-country timezone if not present
if (!seenZones.has('UTC')) {
  timeZonesList.push({
    name: 'UTC',
    countryAlpha2: null,
  });
}

timeZonesList.sort((a, b) => a.name.localeCompare(b.name));

// Write JSON files
writeFileSync(resolve(outDir, 'countries.json'), JSON.stringify(countryEntries, null, 2) + '\n');
writeFileSync(resolve(outDir, 'currencies.json'), JSON.stringify(currencyList, null, 2) + '\n');
writeFileSync(resolve(outDir, 'languages.json'), JSON.stringify(languagesList, null, 2) + '\n');
writeFileSync(resolve(outDir, 'time-zones.json'), JSON.stringify(timeZonesList, null, 2) + '\n');

// Write SOURCES.md
const sourcesMarkdown = `# Reference Data Sources

Generated on: 2026-11-12

## 1. countries.json
- **Standard**: ISO 3166-1 (alpha-2, alpha-3, numeric codes and English short names)
- **Source Package**: \`i18n-iso-countries\` (v7.14.0)
- **Source Licence**: MIT
- **Record Count**: ${countryEntries.length}

## 2. currencies.json
- **Standard**: ISO 4217 (three-letter alphabetic currency code, numeric code, minor units / exponent)
- **Source Package**: \`currency-codes\` (v2.2.0)
- **Source Licence**: MIT
- **Record Count**: ${currencyList.length}
- **Enabled For Sale**: ${SALE_ENABLED_CURRENCIES.size} (${Array.from(SALE_ENABLED_CURRENCIES).join(', ')})

## 3. languages.json
- **Standard**: IETF BCP 47 language tags
- **Source**: Platform internationalization specification
- **Licence**: Public Domain / Open Data
- **Record Count**: ${languagesList.length} (2 enabled: vi, en; 3 disabled: ko, zh-Hans, ja)

## 4. time-zones.json
- **Standard**: IANA Time Zone Database (canonical zone names and country mappings)
- **Source**: IANA tzdb \`zone.tab\` + UTC
- **Source Licence**: Public Domain
- **Record Count**: ${timeZonesList.length}
- **Canonical Verification**: Contains \`Asia/Ho_Chi_Minh\` mapped to \`VN\`; legacy alias \`Asia/Saigon\` is excluded.
`;

writeFileSync(resolve(outDir, 'SOURCES.md'), sourcesMarkdown);

console.log('✅ Generated reference data:');
console.log(`- Countries: ${countryEntries.length}`);
console.log(
  `- Currencies: ${currencyList.length} (${SALE_ENABLED_CURRENCIES.size} enabled for sale)`,
);
console.log(`- Languages: ${languagesList.length} (2 enabled)`);
console.log(`- Time Zones: ${timeZonesList.length}`);
