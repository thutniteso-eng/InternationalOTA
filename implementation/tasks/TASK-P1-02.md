# TASK P1-02 — Continuous Integration

## OBJECTIVE
Every PR and every push to `main` is automatically checked; a failing check blocks merging.

## BACKGROUND
Depends on P1-01 (merged). Read `docs/ENGINEERING_STANDARDS.md` → Dependencies (licence policy).

## SCOPE (create)
- `.github/workflows/ci.yml`
- `tools/check-licenses.mjs` (+ its unit test)
- Root script `licenses:check`

## OUT OF SCOPE
Deployment workflows, release automation, changes to application code (except fixing what CI reveals — list each fix in the report).

## TECHNICAL INSTRUCTIONS
1. Triggers: `pull_request`, `push` to `main`. Cancel superseded runs (`concurrency`).
2. Job `verify` on `ubuntu-latest`: checkout → setup Node from `.nvmrc` → Corepack pnpm → pnpm store cache → `pnpm install --frozen-lockfile` → `format:check` → `lint` → `typecheck` → `test` → `build`.
3. Job `security`: `pnpm audit --prod --audit-level high` (fail on high/critical) and `pnpm licenses:check`.
4. `check-licenses.mjs`: read `pnpm licenses list --json`; allow MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, MPL-2.0, CC0-1.0, BlueOak-1.0.0, Python-2.0 (and `OR` expressions containing an allowed one); fail on anything else, printing package name, version, licence. Exceptions only via `tools/license-exceptions.json` with a reason field (start empty).
5. Pin third-party GitHub Actions to a major version tag from official publishers only (actions/*, pnpm/*).
6. Job `services` is NOT needed yet (DB integration tests arrive in P1-03).

## ACCEPTANCE CRITERIA
- CI green on the PR.
- Proof of blocking: on the same PR, push a temporary commit with a failing test → CI red (screenshot or run URL in report) → revert → green.
- `check-licenses` unit test covers allowed, denied, `OR` expression, exception file.
- Total CI time reported (target < 8 min).

## DELIVERABLES
Branch `task/P1-02-ci`, PR `[P1-02] Continuous integration`, report `reports/TASK-P1-02-report.md` with run URLs.

## OWNER ACTION AFTER MERGE
GitHub → Settings → Branches → add rule for `main`: require PR, require status checks `verify` and `security`, block force pushes.
