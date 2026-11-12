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
