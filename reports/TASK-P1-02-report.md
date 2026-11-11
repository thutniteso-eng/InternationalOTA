# TASK P1-02 report

## Implemented
- Created GitHub Actions CI workflow (`.github/workflows/ci.yml`) triggered on `pull_request` and `push` to `main`, with concurrency group cancel-in-progress.
- Configured two parallel CI jobs:
  - `verify`: Runs on `ubuntu-latest`, checks out repository, configures Node.js from `.nvmrc` and pnpm via official actions (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`), enables pnpm store cache, runs `pnpm install --frozen-lockfile`, followed by `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
  - `security`: Runs on `ubuntu-latest`, checks out repository, configures Node.js/pnpm, runs `pnpm install --frozen-lockfile`, followed by `pnpm audit --prod --audit-level high` and `pnpm licenses:check`.
- Created license checker script (`tools/check-licenses.mjs`):
  - Implemented recursive-descent SPDX expression parser (`tokenize`, `parseExpression`, `parseOr`, `parseAnd`, `parseFactor`) respecting standard precedence (`AND` binds tighter than `OR`, parentheses respected, `WITH` clauses evaluated against explicitly allowed pairs, malformed syntax safely rejected).
  - Validates licenses against approved list: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, MPL-2.0, CC0-1.0, BlueOak-1.0.0, Python-2.0.
  - Enforces strict exception schema `{ "<pkg>": { "license": "<exact SPDX>", "reason": "..." } }`, validating that exceptions apply only when the observed package license strictly matches the declared `license`.
  - Implemented strict exception file loader (`loadExceptions`), failing loudly (exit code 1) on invalid JSON syntax, non-object schema, or entries missing required `license` or `reason` fields.
- Created comprehensive unit test suite (`tools/check-licenses.spec.ts`) with 16 tests covering allowed licenses, unallowed licenses, operator precedence, nested parentheses, WITH clauses, syntax error rejection, exception matching vs license mismatch rejection, invalid exceptions file handling, and CLI execution.
- Added root scripts and tool coverage:
  - `"licenses:check": "node tools/check-licenses.mjs"`
  - `"format:check": "pnpm -r run format:check && prettier --check tools"`
  - `"lint": "pnpm build:packages && pnpm -r run lint && eslint tools"`
  - `"test": "pnpm build:packages && pnpm -r run test && vitest run tools"`
- Added approved license exceptions (`tools/license-exceptions.json`) for `caniuse-lite` and `@img/sharp-libvips-linux-x64` with documented rationales approved by technical authority.
- Carried item from P1-01 review (L2): Replaced repo-wide `AGENTS.md` entry in `.gitignore` with `apps/web/AGENTS.md`.

## Files created/modified/deleted
- **Created**:
  - `.github/workflows/ci.yml`
  - `tools/check-licenses.mjs`
  - `tools/check-licenses.spec.ts`
  - `tools/license-exceptions.json`
- **Modified**:
  - `.gitignore` (replaced repo-wide `AGENTS.md` with `apps/web/AGENTS.md`)
  - `package.json` (added `licenses:check` script, updated `format:check`, `lint`, and `test` scripts to cover `tools/`)
  - `eslint.config.mjs` (configured `allowDefaultProject: ['tools/*.ts']` for type-aware linting)
- **Deleted**: None

## Technical decisions made
1. **Recursive-Descent SPDX Parser (No External Dependencies)**:
   Implemented a lexer (`tokenize`) and recursive-descent parser (`parseOr` -> `parseAnd` -> `parseFactor`) adhering to standard boolean and SPDX semantics:
   - `AND` binds tighter than `OR`.
   - Arbitrary and nested parentheses `(...)` are strictly respected.
   - `WITH <exception>` requires the base license to be approved AND the pair to be explicitly registered in `ALLOWED_WITH_PAIRS` (defaults to empty set).
   - Any malformed expression or tokenization failure safely returns `false`.
2. **License-Bound Exceptions**:
   Exceptions in `tools/license-exceptions.json` bind directly to a specific SPDX license string via `{ [pkg]: { license, reason } }`. If an exempted package changes or upgrades its license (e.g., to GPL-3.0), the exception does not apply and CI fails immediately.
3. **Strict Exception File Validation**:
   If `tools/license-exceptions.json` is missing, it is treated as having no exceptions (`{}`). If the file exists but contains invalid JSON or schema violations (missing `license` or `reason`), the tool logs a clear error message and halts with exit code 1.
4. **Root Tooling Coverage in CI & Scripts**:
   Updated root `package.json` scripts `format:check` (`prettier --check tools`) and `lint` (`eslint tools`) alongside `test` (`vitest run tools`) so all static analysis checks uniformly inspect `tools/`.
5. **Approved Exception Decisions (Claude, Technical Authority)**:
   - `caniuse-lite` (`CC-BY-4.0`): Approved — data licence, attribution only; transitive dependency via Next.js.
   - `@img/sharp-libvips-linux-x64` (`LGPL-3.0-or-later`): Approved — server-side use: dynamically loaded, unmodified prebuilt binary, not distributed to end users. Must be revisited if binaries are ever shipped to end users (e.g. mobile/desktop).

## Tests executed (exact commands)
1. **GitHub Actions CI - Initial Green Run**:
   - URL: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/42970839494
   - Result: Success
   - Durations: `security` 22s, `verify` 41s (Total CI time: ~45s)
2. **GitHub Actions CI - Proof of Blocking (Deliberately Red Run)**:
   - Introduced failing assertion in `packages/shared/src/index.spec.ts`.
   - Commit: `82cb03a`
   - URL: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/42970985761
   - Result: Failed at step `Run tests` in job `verify` (36s).
3. **GitHub Actions CI - Revert and Restored Green Run**:
   - Reverted failure commit via `git revert HEAD --no-edit`.
   - Commit: `85908d6`
   - URL: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/42971093921
   - Result: Success
   - Durations: `security` 14s, `verify` 44s
4. **GitHub Actions CI - Corrections C1–C4 Green Run**:
   - Commit: `22ea2d8`
   - URL: https://github.com/thutniteso-eng/InternationalOTA/actions/runs/43116463321
   - Result: Success
   - Durations: `security` 26s, `verify` 51s (Total CI time: ~55s, well within 8 min target)
5. **Fresh Clone Verification**:
   ```bash
   rm -rf /tmp/p1check-ci && git clone -b task/P1-02-ci https://github.com/thutniteso-eng/InternationalOTA.git /tmp/p1check-ci && cd /tmp/p1check-ci
   pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm licenses:check
   ```

## Actual results (paste output summary)
Fresh clone verification output:
```text
> internationalota@0.0.1 format:check /tmp/p1check-ci
> pnpm -r run format:check && prettier --check tools

Scope: 3 of 4 workspace projects
packages/shared format:check: All matched files use Prettier code style!
apps/api format:check: All matched files use Prettier code style!
apps/web format:check: All matched files use Prettier code style!
Checking formatting...
tools/check-licenses.mjs
tools/check-licenses.spec.ts
tools/license-exceptions.json
All matched files use Prettier code style!

> internationalota@0.0.1 lint /tmp/p1check-ci
> pnpm build:packages && pnpm -r run lint && eslint tools

Scope: 3 of 4 workspace projects
packages/shared lint: Done in 1.5s
apps/api lint: Done in 2.6s
apps/web lint: Done in 3.1s
Done in 3.6s

> internationalota@0.0.1 typecheck /tmp/p1check-ci
> pnpm build:packages && pnpm -r run typecheck

Scope: 3 of 4 workspace projects
packages/shared typecheck$ tsc --noEmit
apps/api typecheck$ tsc --noEmit
apps/web typecheck$ next typegen && tsc --noEmit
Done in 2.1s

> internationalota@0.0.1 test /tmp/p1check-ci
> pnpm build:packages && pnpm -r run test && vitest run tools

Scope: 3 of 4 workspace projects
packages/shared test: 1 passed
apps/api test: 1 passed
apps/web test: 1 passed
tools/check-licenses.spec.ts: 16 passed (16)
Test Files  1 passed (1)
Tests  16 passed (16)

> internationalota@0.0.1 build /tmp/p1check-ci
> pnpm -r run build

Scope: 3 of 4 workspace projects
packages/shared: tsc (Done in 940ms)
apps/api: tsc -p tsconfig.build.json (Done in 1.4s)
apps/web: next build (Done in 9.3s)

> internationalota@0.0.1 licenses:check /tmp/p1check-ci
> node tools/check-licenses.mjs

✅ All 282 package licenses verified successfully.
```

## Corrections (Review C1–C4)
| Item | Description of Change | Evidence & Local Test Output | Green CI Run URL |
| :--- | :--- | :--- | :--- |
| **C1** | Replaced naive splitting with a recursive-descent SPDX parser in `tools/check-licenses.mjs`. Correct precedence enforced (`AND` binds tighter than `OR`), parentheses parsed recursively, `WITH` clauses checked against `ALLOWED_WITH_PAIRS`, malformed syntax safely returns `false`. | `tools/check-licenses.spec.ts`: verified `isLicenseAllowed("GPL-3.0 AND (MIT OR Apache-2.0)")` returns `false`, `isLicenseAllowed("MIT OR (GPL-3.0 AND BSD-3-Clause)")` returns `true`, nested parentheses tests pass, `WITH` tests pass, malformed inputs rejected. | [Run 43116463321](https://github.com/thutniteso-eng/InternationalOTA/actions/runs/43116463321) |
| **C2** | Updated exceptions schema to `{ "<pkg>": { "license": "<exact SPDX>", "reason": "..." } }`. In `checkLicenses`, exceptions only apply if observed license string matches `exception.license`. Updated `tools/license-exceptions.json` with Claude's approval decisions for `caniuse-lite` (`CC-BY-4.0`) and `@img/sharp-libvips-linux-x64` (`LGPL-3.0-or-later`). | `tools/check-licenses.spec.ts`: test `allows an unallowed package when exception matches exact license and has reason` passed; test `rejects an exception when observed license mismatches the exception license` passed (e.g. caniuse-lite re-licensed to GPL-3.0 fails). | [Run 43116463321](https://github.com/thutniteso-eng/InternationalOTA/actions/runs/43116463321) |
| **C3** | Implemented `loadExceptions(exceptionsPath)` in `tools/check-licenses.mjs`. Missing file returns `{}`. If file exists but contains invalid JSON or schema errors (missing/empty `license` or `reason`), it throws and `run()` logs clear error and halts execution (exit code 1). | `tools/check-licenses.spec.ts`: tests for missing file, invalid JSON, and invalid schema pass. `run()` returns `false` with error logged to `console.error`. | [Run 43116463321](https://github.com/thutniteso-eng/InternationalOTA/actions/runs/43116463321) |
| **C4** | Updated root `package.json` scripts: `"format:check": "pnpm -r run format:check && prettier --check tools"` and `"lint": "pnpm build:packages && pnpm -r run lint && eslint tools"`. | `pnpm format:check` verified formatting across packages and `tools/`. `pnpm lint` ran eslint on workspace packages and `tools/` with 0 errors. | [Run 43116463321](https://github.com/thutniteso-eng/InternationalOTA/actions/runs/43116463321) |

## Known limitations
- CI does not yet include Docker / PostgreSQL test containers; database integration tests will be introduced in TASK P1-03 per task spec.
- GitHub Actions runner issues informational warning regarding Node 20 action runner deprecation migration for official actions; execution automatically runs on Node 24 on runner.

## Deviations from spec (and why)
- None. All instructions, constraints, corrections C1–C4, and acceptance criteria were followed exactly.

## Remaining risks
- Branch protection on `main` requires repository owner configuration in GitHub repository settings after PR merge (`require status checks verify and security, block force pushes`).
