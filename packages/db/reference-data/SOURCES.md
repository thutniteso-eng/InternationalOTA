# Reference Data Sources

Generated on: 2026-11-12

## 1. countries.json
- **Standard**: ISO 3166-1 (alpha-2, alpha-3, numeric codes and English short names)
- **Source Package**: `i18n-iso-countries` (v7.14.0)
- **Source Licence**: MIT
- **Record Count**: 250
- **Note on Kosovo**: `XK/XKK/983` is a user-assigned code element in ISO 3166-1, not an officially designated ISO 3166-1 standard code. It is deliberately included in the dataset because Kosovo is an international travel destination.

## 2. currencies.json
- **Standard**: ISO 4217 (three-letter alphabetic currency code, numeric code, minor units / exponent)
- **Source Package**: `currency-codes` (v2.2.0)
- **Source Licence**: MIT
- **Record Count**: 179
- **Enabled For Sale**: 10 (VND, USD, EUR, GBP, AUD, SGD, THB, CNY, KRW, JPY)
- **Note on Minor Units**: 13 non-currency / bond unit / commodity / technical codes (`XAG, XAU, XBA, XBB, XBC, XBD, XDR, XPD, XPT, XSU, XTS, XUA, XXX`) define minor units as "N.A." in ISO 4217 and are recorded as `null` (not 0); circulating currencies with 0 minor units (`XAF, XOF, XPF`, etc.) are recorded as 0.

## 3. languages.json
- **Standard**: IETF BCP 47 language tags
- **Source**: Platform internationalization specification
- **Licence**: Public Domain / Open Data
- **Record Count**: 5 (2 enabled: vi, en; 3 disabled: ko, zh-Hans, ja)

## 4. time-zones.json
- **Standard**: IANA Time Zone Database (canonical zone names and country mappings)
- **Source**: IANA tzdb `zone.tab` + UTC
- **tzdata Version**: `2026e` (system package `tzdata` version `2026e-0ubuntu0.22.04.1`, source file `/usr/share/zoneinfo/zone.tab`)
- **Source Licence**: Public Domain
- **Record Count**: 419
- **Canonical Verification**: Contains `Asia/Ho_Chi_Minh` mapped to `VN`; legacy alias `Asia/Saigon` is excluded.
