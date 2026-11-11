# Phase 0 Audit Plan

## Scope (reduced after preliminary verification)
- Deep audit: **HAIP** (booking/inventory correctness, module design, licence of deps), **OTAIP** (adapter/contract patterns).
- Light audit (patterns only): Medusa (module + workflow engine), Vendure (plugin architecture).
- No further work: QloApps (reference notes only), Sharetribe (rejected).
Rationale: spend tokens where reuse or learning is realistic.

## Procedure per repo (isolated, read-only)
1. Licence: root + `THIRD_PARTY_LICENSES` + automated scan (`license-checker`/`pnpm licenses list`) → flag GPL/AGPL/SSPL/custom.
2. Security: `pnpm audit`/`osv-scanner`; secrets grep; auth middleware review.
3. Build & tests: install in container, run test suite, record pass/fail counts (README badges are not evidence).
4. Correctness drills (HAIP): concurrent booking of last room (N parallel requests), duplicate idempotency key, payment-webhook replay/out-of-order, cancel during confirm.
5. Architecture: module coupling (import graph), DB schema & migrations, multi-tenancy, i18n/currency/timezone handling.
6. Output: one row in AUDIT_SCORECARD (create when audits start) with hard-blocker column separate from scores.

## Hard blockers (any one = reject as foundation/module)
Unacceptable licence · cannot self-host · unresolved critical vuln · incorrect booking/inventory behaviour under concurrency · proprietary infra lock-in.

## Verdict categories
Adopt as foundation · Reuse as independent module · Technical reference · Reject.

## Tooling needs (Owner authorization required)
Docker + Node 22 + pnpm in an isolated audit environment (not the Owner's production machines).
