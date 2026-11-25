# Current State — 2026-11-11

Phase: **1 started** (Phase 0 remaining items run in parallel: HAIP deep audit, D-007 identity spike, D-004 legal).
Repo: github.com/thutniteso-eng/InternationalOTA (private). Owner works in WSL on Windows; Antigravity implements; Claude reviews PRs on GitHub.

Approved: D-001, D-002, D-003, D-005, D-006, D-008, D-009, D-010. Accepted technical: D-011 Drizzle, D-012 pg-boss, D-013 runtime.
Open: D-004 (merchant model). Decided: D-007 Better Auth, D-014 no GitHub Pro (revisit before Phase 2).

Task status:
| Task | Status |
|---|---|
| P1-01 Monorepo skeleton | DONE — merged (PR #1) with limitations L1, L3 |
| P1-02 CI | DONE — merged (PR #2) |
| P1-03 DB foundation | DONE — merged (PR #3); D1–D3 fixed in P1-04 |
| P1-04 Money, FX, time | DONE — merged (PR #5); E1–E3 fixed in P1-05 |
| P1-05 Reference data | DONE — merged (PR #7) |
| P1-06 Identity | READY — spec in implementation/tasks (start after P1-07 merged) |
| P1-07 Idempotency-Key | ACCEPTED WITH LIMITATIONS (H1 → P1-06) — verified locally; GitHub CI blocked by billing; awaiting Owner merge of PR #9 |

No application code exists yet.

Note: GitHub branch protection / rulesets are NOT available for private repos on the free plan (API returned 403 "Upgrade to GitHub Pro"). Owner decided D-014 = no upgrade for now; merges rely on the rule "only PRs Claude marked ACCEPTED, with green CI".

Note (2026-11-25): GitHub Actions refuses to start jobs — "recent account payments have failed or spending limit needs to be increased". Owner to check Billing. Until fixed, Claude verifies locally and records it in each review.
