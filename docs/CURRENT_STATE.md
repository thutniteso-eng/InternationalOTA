# Current State — 2026-11-26

Phase: **2 — Booking core** (approved 2026-11-26, D-019). Phase 1 complete, see `reports/PHASE-1-GATE.md`.
Repo: github.com/thutniteso-eng/InternationalOTA (public, D-015). Branch protection on `main`: required checks `verify` + `security`. Claude merges accepted PRs (D-016).
Staging: Owner's WSL + Docker + Cloudflare quick tunnel (D-017), `scripts/staging-up.sh` / `staging-down.sh`; URL changes on each start.

## Phase 1 tasks (all merged)
| Task | PR |
|---|---|
| P1-01 Monorepo skeleton | #1 |
| P1-02 CI (licence + audit gates) | #2 |
| P1-03 DB foundation (Drizzle, row locks) | #3 |
| P1-04 Money / FX / time | #5 |
| P1-05 Reference data | #7 |
| P1-06 Identity (Better Auth behind own module) | #12 |
| P1-07 Idempotency-Key | #9 |
| P1-08 Outbox, pg-boss, webhook inbox | #14 |
| P1-09 Double-entry ledger (DB-enforced) | #16 |
| P1-10 Observability (logs, request id, redaction, tracing) | #18 |
| P1-11 i18n vi/en | #20 |
| P1-12 Staging + all carry-overs closed | #22 |

## Decisions
Approved/decided: D-001…D-003, D-005…D-017 (see DECISIONS.md). **Open: D-004 merchant model (legal/accounting).**
D-018: verified email required before payment. D-020: external integrations via adapters; Mock gateway + Mailpit locally.

## Open items outside code
- Real payment gateway (Owner) — deferred by D-020; P2-06 builds the Mock gateway, no longer blocked.
- Legal/accounting advice for D-004 (Owner) — blocks live sales, not development.
- Real tour data (Owner) — demo set used meanwhile (implementation/demo-data, PR #25).

## Phase 2 tasks
| Task | Status |
|---|---|
| P2-01 Catalog (suppliers, tours/activities, vi/en, search, geo) | MERGED #27 (limitations N1 supplier IN-list, N2 republish keeps published_at) |
| P2-02 Dated inventory (departures, DB-enforced capacity) | MERGED #29 (L1 tz change → P2-03; L2–L5 documented on PR) |
| P2-03 Pricing & cancellation policy (versioned, snapshot) | MERGED #31 (after R1 item-append, R2 fail-open port, R3 tz/generation race) |
