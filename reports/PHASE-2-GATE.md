# Phase 2 Gate Review (Claude, 2026-11-28)

## Gate criteria (MASTER_ROADMAP: "Concurrency/idempotency/failure test suite passes; first real bookings")
| Criterion | Status | Evidence |
|---|---|---|
| Phase 2 tasks accepted | ✅ | P2-01 #27 · P2-02 #29 · P2-03 #31 · P2-09A #34 · P2-04 #36 · P2-05 (+P2-06, D-022) #38 · P2-07 #40 · P2-08 #43 · P2-09 #45 · H-1 #47 · P2-10 #51 · P2-11 #53 |
| 8 mandatory failure scenarios pass in CI | ✅ | `apps/api/test/failure-scenarios/fs-01…fs-08`, CI step "Failure scenarios"; each ends with reconciliation `ok` |
| Daily reconciliation, zero unexplained differences | ✅ (staging) | P2-10; staging run `ok`, 0 errors / 0 warnings after R3 |
| CI green on `main`, no high/critical vulns, licence gate | ✅ | required checks `verify`, `security` |
| Demo 1 + Demo 2 on staging (Owner viewed) | ✅ | D-021; P2-09 e2e on staging |
| **First real bookings** | ❌ | Blocked — see "Blockers for live sales" |

## Quality record
- First submissions rejected in 8 of 13 Phase-2 PRs; every defect fixed before merge. Most significant defects caught by independent verification (raw-SQL probes, mutation tests, CI diagnosis):
  - price lists mutable by appending items (P2-03); time-zone lock failing open + tz/generation race (P2-03);
  - booking core columns (seats, hold expiry, price snapshot) rewritable during a legal transition (P2-04);
  - currency-mismatch path untested (P2-05);
  - booking list cursor losing microseconds → skipped rows (found while diagnosing a "flaky" CI run, H-1);
  - admin audit failing open; outbox events without consumers dead-lettering → permanently noisy reconciliation (P2-10).
- FS-05 (crash mid-saga) uncovered two real recovery gaps, both fixed: lost `provider_ref` after crash; refunds stuck in `processing`.
- Process incidents: Claude-driven desktop control of Antigravity sent one message to the wrong conversation (stopped in 7 s, disregarded; rule added: confirm conversation title before typing). Antigravity ran out of AI credits once (paused by Owner).

## Known limitations carried forward (documented on PRs)
- Catalog: supplier IN-list per request (revisit ~1,000 suppliers); republish keeps `published_at`.
- Inventory: ambiguous DST fall-back times resolved by PostgreSQL (irrelevant for VN); generation accepts past dates / unbounded times.
- Notifications: at-least-once in the crash window between SMTP send and mark-sent.
- Retained cancellation amounts posted to a neutral liability (`cancellation_retained`) until D-004.
- Real PSP adapters must implement idempotent refunds by `refundId` and `getCheckoutByAttemptId` (recovery depends on it).

## Blockers for live sales (Owner)
1. **D-004 merchant model + legal entity** (company vs household business; travel licence; e-commerce platform registration with MOIT; Law 122/2025 + Decree 248/2026 obligations). Needs a lawyer.
2. **Production payment gateway contract** (VNPay first; OnePay for international cards) — requires the legal entity.
3. **Production hosting + domain** (staging runs on the Owner's laptop via a temporary tunnel).
4. **Real supplier content and contracts** (demo data only today).

## Recommendation
- Declare Phase 2 **technically complete**.
- Do **not** start Phase 3 (hotels) yet. Insert a short **Release-readiness track (R-phase)** that needs no legal decision, so that the platform is ready the day the Owner's legal/PSP prerequisites land:
  - R-1 Production infrastructure on a VPS (provisioning as code, TLS, backups + restore drill, monitoring/alerting, log retention, secrets management).
  - R-2 VNPay adapter against the VNPay **sandbox** behind the existing `PaymentProvider` port (sandbox registration is free; no contract needed).
  - R-3 Security review: authN/authZ sweep, rate limits, OWASP ASVS L1 checklist, dependency and container scanning, admin 2FA.
  - R-4 Legal/policy pages + consent (terms, privacy, cancellation, payment policy) as templates for the lawyer to review; cookie consent.
  - R-5 Catalog/pricing/inventory admin UI so staff can enter real suppliers without engineers.
- In parallel, the Owner pursues D-004, company registration, the VNPay merchant contract and the domain.
