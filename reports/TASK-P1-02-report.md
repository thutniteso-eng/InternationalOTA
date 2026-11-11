# TASK P1-02 report

## Implemented
- Created GitHub Actions CI workflow (`.github/workflows/ci.yml`) triggered on `pull_request` and `push` to `main`, with concurrency group cancel-in-progress.
- Configured two parallel CI jobs:
  - `verify`: Runs on `ubuntu-latest`, checks out repository, configures Node.js from `.nvmrc` and pnpm via official actions (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`), enables pnpm store cache, runs `pnpm install --frozen-lockfile`, followed by `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
  - `security`: Runs on `ubuntu-latest`, checks out repository, configures Node.js/pnpm, runs `pnpm install --frozen-lockfile`, followed by `pnpm audit --prod --audit-level high` and `pnpm licenses:check`.
- Created license checker script (`tools/check-licenses.mjs`):
  - Reads production licenses via `pnpm licenses list --json` and exception list from `tools/license-exceptions.json`.
  - Validates licenses against approved list: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, MPL-2.0, CC0-1.0, BlueOak-1.0.0, Python-2.0.
  - Supports compound license expressions: `OR` expressions (allowed if any option is allowed) and `AND` expressions (all components must be allowed).
  - Enforces mandatory non-empty `reason` field for any exemption in `tools/license-exceptions.json`.
  - Reports package name, version, and license on violation with non-zero exit code.
- Created comprehensive unit test suite (`tools/check-licenses.spec.ts`) with 11 tests covering allowed licenses, unallowed licenses, `OR` expressions, `AND` expressions, violations reporting, exemptions with reasons, and rejection of exemptions missing reasons.
- Added root script `"licenses:check": "node tools/check-licenses.mjs"` and integrated tool testing into root `"test"` script (`vitest run tools`).
- Added license exceptions for transitive production dependencies pulled by Next.js (`caniuse-lite` CC-BY-4.0 and `@img/sharp-libvips-linux-x64` LGPL-3.0-or-later) with documented justifications.
- Carried item from P1-01 review (L2): Replaced repo-wide `AGENTS.md` entry in `.gitignore` with `apps/web/AGENTS.md`.

## Files created/modified/deleted
- **Created**:
  - `.github/workflows/ci.yml`
  - `tools/check-licenses.mjs`
  - `tools/check-licenses.spec.ts`
  - `tools/license-exceptions.json`
- **Modified**:
  - `.gitignore` (replaced repo-wide `AGENTS.md` with `apps/web/AGENTS.md`)
  - `package.json` (added `licenses:check` script, updated `test` script to include `vitest run tools`)
  - `eslint.config.mjs` (configured `allowDefaultProject: ['tools/*.ts']` for type-aware linting)
- **Deleted**: None

## Technical decisions made
1. **GitHub Actions Pinning & Caching**: Used official major version actions (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`). Setup Node configured with `cache: 'pnpm'` using Corepack / pnpm action setup for fast, deterministic dependency caching.
2. **Compound License Parsing**: Handled both `OR` expressions (passes if any option is in allowed set) and `AND` expressions (e.g. `@swc/core-linux-x64-gnu` with `Apache-2.0 AND MIT`, passes only if all parts are allowed).
3. **Workspace-friendly Tool Testing**: Included `vitest run tools` in the root `pnpm test` script. Vitest directly executes `tools/check-licenses.spec.ts` without requiring a separate workspace package or tsconfig for tools.
4. **ESLint Integration**: Added `tools/*.ts` to `eslint.config.mjs` under `projectService.allowDefaultProject` to enable strict TypeScript linting on utility scripts without parsing errors.

## Tests executed (exact commands)
1. **GitHub Actions CI - Initial Green Run**:
   - URL: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/42970839494
   - Result: Success
   - Durations: `security` 22s, `verify` 41s (Total CI time: ~45s, well within 8 min target)
2. **GitHub Actions CI - Proof of Blocking (Deliberately Red Run)**:
   - Introduced failing assertion in `packages/shared/src/index.spec.ts` (`expect(formatPlatformGreeting(info)).toBe('DELIBERATE CI FAILURE...')`).
   - Commit: `82cb03a`
   - URL: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/42970985761
   - Result: Failed at step `Run tests` in job `verify` (36s). Proves CI blocks failing code.
3. **GitHub Actions CI - Revert and Restored Green Run**:
   - Reverted failure commit via `git revert HEAD --no-edit`.
   - Commit: `85908d6`
   - URL: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/42971093921
   - Result: Success
   - Durations: `security` 14s, `verify` 44s (Total CI time: ~47s)
4. **Fresh Clone Verification**:
   ```bash
   rm -rf /tmp/p1check-ci && git clone -b task/P1-02-ci https://github.com/thutniteso-eng/InternationalOTA.git /tmp/p1check-ci && cd /tmp/p1check-ci
   pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm licenses:check
   ```

## Actual results (paste output summary)
Fresh clone verification output:
```text
> internationalota@0.0.1 format:check /tmp/p1check-ci
> prettier --check "**/*.{ts,tsx,js,mjs,json,md,yml,yaml}"

Checking formatting...
All matched files use Prettier code style!

> internationalota@0.0.1 lint /tmp/p1check-ci
> pnpm build:packages && pnpm -r run lint
...
Scope: 3 of 4 workspace projects
packages/shared lint$ eslint .
apps/api lint$ eslint .
apps/web lint$ eslint .
Done in 1.6s

> internationalota@0.0.1 typecheck /tmp/p1check-ci
> pnpm build:packages && pnpm -r run typecheck
...
Scope: 3 of 4 workspace projects
packages/shared typecheck$ tsc --noEmit
apps/api typecheck$ tsc --noEmit
apps/web typecheck$ tsc --noEmit
Done in 2.0s

> internationalota@0.0.1 test /tmp/p1check-ci
> pnpm build:packages && pnpm -r run test && vitest run tools
...
Scope: 3 of 4 workspace projects
packages/shared test: 1 passed
apps/api test: 2 passed
apps/web test: 1 passed
tools/check-licenses.spec.ts: 11 passed (11)
Test Files  1 passed (1)
Tests  11 passed (11)

> internationalota@0.0.1 build /tmp/p1check-ci
> pnpm -r run build
...
packages/shared: tsc (Done in 751ms)
apps/api: tsc -p tsconfig.build.json (Done in 1.2s)
apps/web: next build (Done in 7.7s)

> internationalota@0.0.1 licenses:check /tmp/p1check-ci
> node tools/check-licenses.mjs

✅ All 282 package licenses verified successfully.
```

## Known limitations
- CI does not yet include Docker / PostgreSQL test containers; database integration tests will be introduced in TASK P1-03 per task spec.
- GitHub Actions runner issues informational warning regarding Node 20 action runner deprecation migration for official actions; execution automatically runs on Node 24 on runner.

## Deviations from spec (and why)
- None. All instructions, constraints, and acceptance criteria were followed exactly.

## Remaining risks
- Branch protection on `main` requires repository owner configuration in GitHub repository settings after PR merge (`require status checks verify and security, block force pushes`).
