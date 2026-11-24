# Decision Log (ADR index)
Status: PROPOSED → APPROVED / REJECTED by Project Owner. Full ADR text goes in `docs/adr/NNN-*.md` once approved.

| ID | Decision | Proposal | Status |
|---|---|---|---|
| D-001 | Initial market & scope | Vietnam destination-first; hotels + tours/activities + transfers; no flights/native apps in MVP | APPROVED 2026-11-11 |
| D-002 | Foundation strategy | Build own booking core (modular monolith); audited repos = reference/modules only | APPROVED 2026-11-11 |
| D-003 | Source of truth & collaboration | Private Git repo (GitHub) holds code + docs; Antigravity works via branches/PRs; Claude reviews PRs | APPROVED 2026-11-11 |
| D-004 | Merchant model | Decide agent vs merchant-of-record (drives payments, tax, invoicing, refunds) — needs legal/accounting advice | OPEN (Owner) |
| D-005 | Supply strategy | Mix: direct contracts (local hotels/tours) + one wholesaler/bedbank API; evaluate contracts before integration | APPROVED 2026-11-11 |
| D-006 | Workflow engine | DB-persisted saga + pg-boss/BullMQ for MVP; Temporal re-evaluated at Phase 3 | APPROVED 2026-11-11 |
| D-007 | Identity | **Better Auth** (MIT, embedded) behind our own `identity` module; user data in our PostgreSQL schema `identity`; roles in our own `identity.user_roles`; exact version pin; no module outside `identity` may import it. Keycloak rejected for now (separate JVM service, only latest minor gets security fixes → high ops load for a one-person team). Revisit if enterprise partner SSO is required (~Phase 4). Known risk: library acquired by Vercel (2026-07) — mitigated by MIT licence + wrapper | DECIDED (Owner) 2026-11-12 |
| D-008 | Search | PostgreSQL FTS + PostGIS first; OpenSearch deferred | APPROVED 2026-11-11 |
| D-009 | Mobile | PWA first; native framework chosen at Phase 5 | APPROVED 2026-11-11 |
| D-010 | Rejections | Sharetribe Go rejected (licence excludes SaaS, unmaintained); QloApps rejected as foundation | APPROVED 2026-11-11 |
| D-011 | ORM & migrations | Drizzle ORM + drizzle-kit, SQL migrations committed, **forward-only** (rollback = new migration + tested backup restore). Reason: SQL-first, native row locks (`.for('update')`), light runtime; Prisma needs raw SQL for locking | ACCEPTED (Claude, technical) 2026-11-11 |
| D-012 | Job queue | pg-boss on PostgreSQL: enqueue in the same transaction as business writes (outbox), no Redis needed for correctness. BullMQ rejected for now (Redis becomes a correctness dependency) | ACCEPTED (Claude, technical) 2026-11-11 |
| D-013 | Runtime | Node.js 24 LTS, pnpm 10, Vitest, PostgreSQL 17 + PostGIS | ACCEPTED (Claude, technical) 2026-11-11 |
| D-014 | Enforce CI on `main` | No upgrade during build-out; manual rule "merge only Claude-ACCEPTED PRs with green CI". **Revisit before Phase 2** (payments/booking) | DECIDED (Owner) 2026-11-12 |
