# Master Roadmap (proposed revision)

| Phase | Content | Gate to exit |
|---|---|---|
| 0 | Research, audit, architecture, ADRs, legal/merchant model decision | Owner approves D-001…D-010 + architecture |
| 1 | Repo, CI, standards, identity, money/time primitives, ledger skeleton, outbox, observability | CI green, ADRs implemented, security baseline |
| 2 | **Booking core + tours/activities (direct inventory)** + payment (1 PSP) | Concurrency/idempotency/failure test suite passes; first real bookings |
| 3 | Hotels: direct contracts + 1 supplier API adapter, content mapping, price revalidation | Supplier failure & reconciliation drills pass |
| 4 | Partner portal, commissions, payables, reconciliation, refunds | Daily reconciliation zero unexplained differences |
| 5 | i18n expansion, customer accounts, reviews, loyalty, mobile apps | — |
| 6 | Flights, packages, new countries, scale | — |

Change vs original: tours/activities moved before hotels-via-API because local direct inventory is simpler to own and validates the booking core with less supplier dependency. Owner may keep the original order (D-001).

## Phase 1 task list (approved plan 2026-11-11)
P1-01 monorepo skeleton · P1-02 CI (lint/typecheck/test/vuln/licence gate) · P1-03 DB foundation, schema-per-module · P1-04 Money/FX/time primitives · P1-05 reference data (ISO 3166/4217, BCP 47, IANA) · P1-06 identity & RBAC (needs D-007) · P1-07 Idempotency-Key middleware · P1-08 outbox + job queue + webhook inbox · P1-09 double-entry ledger · P1-10 observability · P1-11 i18n vi/en · P1-12 staging VPS + backup/restore drill.

## Phase 2 task list
P2-01 catalog · P2-02 dated inventory (DB-enforced non-negative) · P2-03 pricing + cancellation policy snapshot · P2-04 booking aggregate/state machine/holds · P2-05 saga orchestration with compensation · P2-06 first PSP adapter + webhooks · P2-07 cancel/refund · P2-08 notifications · P2-09 customer web · P2-10 minimal admin + daily reconciliation · P2-11 failure-scenario suite in CI.

## Mandatory failure scenarios before live sales
1) 50 concurrent requests for last seat → exactly 1 booking · 2) double pay click → one charge · 3) duplicate/early webhook → correct final state · 4) paid but supplier rejects → auto refund · 5) crash mid-saga → resumes, no loss · 6) hold expires as payment arrives → consistent outcome · 7) price change before pay → reconfirm · 8) cancel during confirm → no contradictory state.
