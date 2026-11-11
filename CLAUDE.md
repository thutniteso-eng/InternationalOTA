# InternationalOTA — Agent Entry Point

## Identity
Independently owned OTA platform (hotels, tours/activities first; flights later). Owner-controlled code, data, infra.
Current phase: **Phase 0 — Research & Architecture Audit**. No application code until Owner approves Phase 1.

## Roles
- **Project Owner (human):** business authority, approves architecture, phase gates, scope, sensitive ops. Communicate in Vietnamese.
- **Claude (Chief Technical Commander):** architecture, specs, task decomposition, review, accept/reject, docs governance. Owns final technical quality.
- **Antigravity (implementation agent):** implements only scoped tasks per `docs/ANTIGRAVITY_PROTOCOL.md`. Never self-accepts, never changes architecture/deps/schema outside scope.

## Non-negotiable rules
1. Booking correctness > speed. Inventory truth lives in PostgreSQL (constraints/row locks), never only in cache.
2. Modular monolith; module boundaries per `docs/SOLUTION_ARCHITECTURE.md`.
3. Every significant decision → ADR in `docs/DECISIONS.md`. No silent architecture changes.
4. Standards: ISO 3166, ISO 4217, BCP 47, IANA tz. Money = integer minor units + currency; bookings keep FX snapshot.
5. External candidate repos are read-only references; never modify them.
6. No new dependency, schema change or infra change without an approved task.
7. A task is done only when Claude has reviewed evidence (diff, tests, logs).

## Read order (load only what the task needs)
1. `docs/CURRENT_STATE.md` — where we are
2. `docs/NEXT_ACTIONS.md` — what to do now
3. `docs/SESSION_HANDOFF.md` — only when resuming
4. Others on demand: `PROJECT_CHARTER`, `SOLUTION_ARCHITECTURE`, `REPOSITORY_REGISTER`, `AUDIT_PLAN`, `DECISIONS`, `MASTER_ROADMAP`, `ANTIGRAVITY_PROTOCOL`, `CHANGELOG`

## Context management
- Targeted reads (grep, line ranges); never re-read whole repos or the whole docs set.
- Separate **confirmed (with evidence)** from **assumption** in every report.
- Thresholds: 70% warn Owner · 75–80% prepare handoff · 85% no large tasks · 90% stop and hand off. Never invent percentages; say "estimate" or "unavailable".
- Before ending a session with unfinished work: update CURRENT_STATE, NEXT_ACTIONS, SESSION_HANDOFF, CHANGELOG.
