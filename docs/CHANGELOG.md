# Changelog

## 2026-11-11
- Created project documentation skeleton (CLAUDE.md, charter, architecture draft, repo register, audit plan, decisions, roadmap, Antigravity protocol, state/next/handoff).
- Merged AI_CONSTITUTION into CLAUDE.md + ANTIGRAVITY_PROTOCOL.md; AUDIT_SCORECARD deferred until audits start (avoid empty files).
- Owner approved D-001, D-002, D-003, D-005, D-006, D-008, D-009, D-010. Added Phase 1/2 task lists and mandatory failure scenarios to MASTER_ROADMAP; updated CURRENT_STATE, NEXT_ACTIONS.
- Repo initialised on GitHub; added ENGINEERING_STANDARDS, README, .gitignore/.gitattributes, D-011..D-013, TASK specs P1-01..P1-03.
- P1-01 PR #1 reviewed: REJECTED (fresh-clone lint/typecheck/test fail; Nest wiring untested). Corrections R1–R8 posted on PR.
- P1-01 re-reviewed at d909571: ACCEPTED WITH LIMITATIONS (L1 api dev no watch, L2 AGENTS.md ignore → P1-02, L3 docker not independently verified).
- P1-01 merged. P1-02 PR #2 reviewed: REJECTED (licence parser precedence bug lets GPL pass; exceptions not bound to licence; silent JSON errors; tools/ unlinted). Approved licence exceptions: caniuse-lite (CC-BY-4.0), sharp-libvips (LGPL-3.0, server-side only).
- P1-02 re-reviewed at e403a6b: ACCEPTED (SPDX parser verified on 11 edge cases; 282 packages licence-clean).
- P1-02 merged. P1-03 reviewed: ACCEPTED WITH LIMITATIONS (lock test mutation-verified; D1 fallback creds, D2 migrate needs build, D3 broken export → P1-04). Added TASK-P1-04 spec. Branch protection unavailable on free private repo → D-014.
- P1-04 reviewed: ACCEPTED WITH LIMITATIONS (rounding/allocation verified, ESLint float ban mutation-verified; E1 FX rate<=0 accepted, E2 FX snapshot defaults, E3 tz validation → P1-05). Added TASK-P1-05 spec.
- P1-05 re-reviewed at ab8a554: ACCEPTED (upsert, idempotency, atomicity, ISO N.A. verified). D-014 decided: no GitHub Pro for now, revisit before Phase 2. Added TASK-P1-07 spec; P1-06 waits for D-007.
- P1-07 PR #9 reviewed: REJECTED (concurrency test never overlaps — mutation survived; 5xx detail leak; app-clock expiry; tests wipe shared DB). D-007 decided: Better Auth. Added TASK-P1-06 spec.
- P1-07 re-reviewed at 0855621: ACCEPTED WITH LIMITATIONS (G1 mutation now killed; H1 same-payload fencing test → P1-06). Antigravity earlier reported a non-existent commit (c3f9a2e…); actual push was 0855621. GitHub Actions blocked by billing since 2026-11-24.
- D-015 decided: repository public (experimental phase); history scanned clean of secrets.
- P1-06 reviewed at 6d039bf: ACCEPTED WITH LIMITATIONS (6/6 mutations killed; L1–L3 → P1-12; L4 email verification before payment = Phase 2 decision). Approved upgrades: vitest 4.1, drizzle-kit 0.31, better-auth 1.7.28 exact. Branch protection now active (public repo). Added TASK-P1-08 spec.
- P1-06 merged (PR #12). D-016: Owner delegated merging of Claude-ACCEPTED, CI-green PRs to Claude.
- P1-08 merged (PR #14) after W1 (unsigned header dedupe bypass) and W2 (unbounded body) were proven and fixed. Added TASK-P1-09 spec.
