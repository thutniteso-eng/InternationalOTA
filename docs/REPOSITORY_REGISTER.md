# Repository Register — preliminary verification (2026-11-11)

Method: shallow clone (read-only, isolated), LICENSE files, top-level structure, targeted code grep. GitHub API metadata (stars, contributors) was NOT available in this session → unverified.
Status legend: ✅ confirmed with evidence · ⚠️ assumption / needs deep audit.

| Repo | Exists / active | License (confirmed) | Stack | What it actually is | Preliminary verdict |
|---|---|---|---|---|---|
| TelivityAI/haip | ✅ last commit 2026-11-09, v0.1.0 | Apache-2.0 (+THIRD_PARTY_LICENSES) | NestJS, Drizzle, Postgres, Keycloak, React | Hotel **PMS** (property ops) with direct booking engine | **Technical reference**; possible separate module later (free PMS for partner hotels). Not OTA foundation |
| Qloapps/QloApps | ✅ last commit 2026-11-06 | OSL-3.0 (network-use clause ⚠️ legal review) | PHP ≥8.2, PrestaShop lineage | Single hotel/chain booking website + backoffice | **Reject as foundation**; reference only |
| TelivityAI/otaip | ✅ last commit 2026-10-23, v0.7.4 | Apache-2.0 | TypeScript, pnpm monorepo | Agent framework for air/hotel distribution, adapters | **Reference** for supplier-adapter and flight design (Phase 6) |
| medusajs/medusa | ✅ last commit 2026-11-10 | MIT **except** Enterprise Materials (RBAC, SSO paths = proprietary) | TypeScript | Retail commerce engine | **Reference** (module system, workflows). Poor fit for date-based inventory. If ever used: exclude EE paths |
| vendurehq/vendure | ✅ last commit 2026-11-10 | GPLv3 or commercial | TypeScript, NestJS, GraphQL | Retail commerce framework | **Reference only** (copyleft risk for derived code) |
| sharetribe/sharetribe | ✅ README: "no longer actively maintained" | Sharetribe Community Public Licence — **excludes SaaS use** | Ruby on Rails, MySQL | Marketplace (Sharetribe Go) | **Hard reject** (licence + unmaintained) |

## Evidence notes
- HAIP: `reservation.service.ts` locks room type row `FOR UPDATE` before creating reservations and uses atomic conditional status transitions; Connect API enforces idempotency keys for hosted checkout. Positive signal, not yet tested. Repo contains CLAUDE.md/AGENTS.md/prompts → largely AI-assisted development; maturity and bus-factor ⚠️.
- HAIP scope is per-property operations (folio, night audit, housekeeping). OTA needs multi-supplier aggregation, content mapping, merchant payments, supplier payables — absent.
- QloApps: 3,427 PHP files, PrestaShop-derived classes. Different language from target stack.
- Medusa: `ENTERPRISE-LICENSE.md` lists RBAC/SSO directories as commercial-only.

## Not yet verified (Phase 0 deep audit)
Dependency licence scan, vulnerability scan, test execution, migration quality, multi-tenancy model, i18n depth, maintainer count.
