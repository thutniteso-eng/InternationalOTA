# Reference Data Sources

Generated on: 2026-11-12

## 1. countries.json
- **Standard**: ISO 3166-1 (alpha-2, alpha-3, numeric codes and English short names)
- **Source Package**: `i18n-iso-countries` (v7.14.0)
- **Source Licence**: MIT
- **Record Count**: 250

## 2. currencies.json
- **Standard**: ISO 4217 (three-letter alphabetic currency code, numeric code, minor units / exponent)
- **Source Package**: `currency-codes` (v2.2.0)
- **Source Licence**: MIT
- **Record Count**: 179
- **Enabled For Sale**: 10 (VND, USD, EUR, GBP, AUD, SGD, THB, CNY, KRW, JPY)

## 3. languages.json
- **Standard**: IETF BCP 47 language tags
- **Source**: Platform internationalization specification
- **Licence**: Public Domain / Open Data
- **Record Count**: 5 (2 enabled: vi, en; 3 disabled: ko, zh-Hans, ja)

## 4. time-zones.json
- **Standard**: IANA Time Zone Database (canonical zone names and country mappings)
- **Source**: IANA tzdb `zone.tab` + UTC
- **Source Licence**: Public Domain
- **Record Count**: 419
- **Canonical Verification**: Contains `Asia/Ho_Chi_Minh` mapped to `VN`; legacy alias `Asia/Saigon` is excluded.
