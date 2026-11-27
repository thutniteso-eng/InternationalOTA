# Solution Architecture — DRAFT v0.1 (not approved)

## Position
Build our own **booking core** as a TypeScript modular monolith. Do NOT adopt any audited repo as the foundation: none of them is an OTA aggregation/booking-orchestration platform (see REPOSITORY_REGISTER.md). Reuse ideas and, where licence allows, isolated pieces.

## Module boundaries (modular monolith, one PostgreSQL, schema-per-module)
| Module | Owns |
|---|---|
| identity | customers, staff, partner users, roles |
| catalog | properties, tours, activities, content, media, geo (ISO 3166, PostGIS) |
| supply | supplier connections/adapters, mapping (our product ↔ supplier codes), contracts |
| inventory | allotments/capacity per date for directly contracted products |
| pricing | rate plans, markups, promotions, commission rules, FX rates |
| search | availability search (Postgres first; OpenSearch later if needed) |
| booking | booking aggregate, state machine, holds, idempotency, saga orchestration |
| payment | PSP adapters, authorizations, captures, refunds, webhook inbox |
| finance | ledger (double-entry), supplier payables, commissions, reconciliation |
| notification | email/SMS/Zalo templates per locale |
| partner-portal / admin | back-office UIs over the modules' APIs |

Rules: modules talk via public service interfaces or domain events (transactional outbox); no cross-module table access.

## Booking correctness design (core of the platform)
- Booking states: `draft → priced → held → payment_authorized → supplier_pending → confirmed` (+ `failed`, `cancel_requested`, `cancelled`, `refunded`). Transitions via atomic conditional UPDATE.
- Every mutating API requires `Idempotency-Key`; stored with request hash.
- Direct inventory: Postgres row lock or constraint per (product, date); Redis only for caching, never as inventory truth.
- Price revalidation with supplier immediately before payment capture; price change → customer reconfirmation.
- Payment: authorize → supplier confirm → capture; compensation (void/refund) on failure.
- Webhooks: inbox table, dedupe by provider event id, tolerate out-of-order (state machine ignores stale transitions).
- Durable workflow: DB-persisted saga + job queue (pg-boss or BullMQ) for MVP; revisit Temporal when flows multiply (ADR D-006).
- Money: integer minor units + ISO 4217; booking stores FX snapshot and original currency. Times: UTC + IANA tz of the service location; check-in dates as local dates.

## Stack (proposals, each needs an ADR)
| Layer | Proposal | Note |
|---|---|---|
| Backend | NestJS + TypeScript strict | Agree with initial proposal |
| ORM/migrations | Drizzle or Prisma (ADR) | Must support row locks + raw SQL |
| DB | PostgreSQL 16+ (+PostGIS) | Agree |
| Web | Next.js (SSR for SEO) | Agree |
| Mobile | Defer; responsive web/PWA first | Flutter vs React Native decided at Phase 5 |
| Search | Postgres FTS + PostGIS first | OpenSearch only when measured need |
| Identity | ADR: Keycloak vs embedded auth library | Keycloak = strong but heavy to operate |
| Queue/workflow | pg-boss/BullMQ + DB saga | Temporal later if justified |
| Cache | Redis | Not for inventory truth |
| Storage | S3-compatible | Agree |
| Observability | OpenTelemetry + structured logs | Agree |
| Hosting | Single VPS/managed Postgres for MVP, Docker Compose; IaC later | Low cost, owner-controlled |

## Cross-module ports (added 2026-11-27, P2-03)
Module dependencies must stay acyclic (`pricing → inventory → catalog → supply`). When a lower module needs a read from a higher one (e.g. catalog asking inventory `hasDepartures`, or pricing summary), the higher module exports a narrow port under a string token (`INVENTORY_DEPARTURE_CHECK_PORT`, `PRICING_SUMMARY_PORT`) and the lower module resolves it via `ModuleRef` in `onModuleInit`. Rules: the port type lives in the providing module's `index.ts`; **safety checks fail closed** when the port is missing (503 + error log); purely presentational reads may degrade to `null` with a boot warning; ports that participate in a locking protocol accept the caller's `tx`.
