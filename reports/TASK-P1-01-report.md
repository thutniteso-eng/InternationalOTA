# TASK-P1-01 report

## Implemented:
Created the complete, buildable monorepo skeleton for InternationalOTA:
- Pinned toolchain: Node.js 24 (.nvmrc) and pnpm 10 (.npmrc engine-strict=true).
- Root monorepo workspace configuration via `pnpm-workspace.yaml` (`apps/*`, `packages/*`).
- Root TypeScript configuration (`tsconfig.base.json`) enforcing `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Flat ESLint configuration (`eslint.config.mjs`) using `typescript-eslint` type-aware linting (`recommendedTypeChecked`), configured for Prettier compatibility.
- Prettier configuration (`.prettierrc`) with repo-wide code style checking.
- Root scripts (`build`, `build:packages`, `lint`, `typecheck`, `test`, `format:check`) ensuring packages build before linting/typechecking/testing.
- Docker Compose configuration (`docker-compose.yml`) running PostgreSQL 17 with PostGIS (`postgis/postgis:17-3.5`) on port 55432 and Redis 7 (`redis:7`) on port 56379 with named volumes and healthchecks, namespaced by compose project name.
- Environment variable specification in `.env.example`.
- `@internationalota/shared`: Pure TypeScript library exporting `PlatformInfo` interface and `formatPlatformGreeting` helper with accompanying unit test.
- `@internationalota/api`: NestJS application with graceful shutdown hooks, `HealthController` exposing `GET /health` returning `{"status":"ok"}`, integration tests using `@nestjs/testing` and `unplugin-swc` with decorator metadata over HTTP `fetch` on port 0.
- `@internationalota/web`: Next.js 16 (App Router, TypeScript) application rendering greeting text from `@internationalota/shared` to demonstrate workspace linking.
- Updated `README.md` with complete local development instructions.

## Installed Versions:
- Node.js: `v24.22.2`
- pnpm: `10.29.3`
- NestJS (@nestjs/core, @nestjs/common, @nestjs/platform-express, @nestjs/testing): `12.4.2`
- Next.js: `16.4.6`
- React / React-DOM: `19.3.1`
- TypeScript: `5.9.3`
- Vitest: `3.2.7`
- PostgreSQL image: `postgis/postgis:17-3.5`
- Redis image: `redis:7`

## Allowed Lifecycle Scripts (pnpm 10 onlyBuiltDependencies):
- `@swc/core`
- `esbuild`

## Files created/modified/deleted:
Created:
- `.nvmrc`
- `.npmrc`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `eslint.config.mjs`
- `.prettierrc`
- `docker-compose.yml`
- `.env.example`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/tsconfig.build.json`
- `apps/api/vitest.config.ts`
- `apps/api/src/main.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/health.controller.ts`
- `apps/api/src/health.controller.spec.ts`
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/next.config.mjs`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/page.tsx`
- `apps/web/src/app/page.spec.ts`
- `apps/web/vitest.config.ts`
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `packages/shared/vitest.config.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/index.spec.ts`
- `reports/TASK-P1-01-report.md`

Modified:
- `.gitignore` (ignored `next-env.d.ts`, `AGENTS.md`, `*.tsbuildinfo`)
- `README.md`

Deleted:
- `vitest.workspace.ts` (deprecated in Vitest 3, per review R6)
- `apps/web/next-env.d.ts` (gitignored, per review R3)

## Technical decisions made:
1. Allow-listed `@swc/core` and `esbuild` in `package.json#pnpm.onlyBuiltDependencies` to satisfy pnpm 10 security defaults while enabling native compilation for SWC and Vite/Vitest.
2. Integrated `unplugin-swc` into `apps/api/vitest.config.ts` with `swc.vite()` to properly transform NestJS decorator metadata during Vitest execution.
3. Created `apps/api/tsconfig.build.json` extending `tsconfig.json` with exclusion for `src/**/*.spec.ts` to ensure production builds contain only runtime code.
4. Used `typescript-eslint` v8 `recommendedTypeChecked` configuration in `eslint.config.mjs` without stylistic rules so that ESLint and Prettier work harmoniously without conflicts.
5. Added `pnpm build:packages` step prior to `lint`, `typecheck`, and `test` root scripts to ensure workspace libraries are compiled on clean clones without needing manual build first.
6. Configured `apps/web` typecheck script as `next typegen && tsc --noEmit` and gitignored `next-env.d.ts` to prevent broken references on fresh clones prior to Next.js route generation.

## Corrections (Addressing Claude Review R1–R8):
- **R1 — Fresh-clone order must pass:**
  - *Change:* In root `package.json`, added script `"build:packages": "pnpm --filter \"./packages/**\" build"`, and updated `lint`, `typecheck`, and `test` scripts to run `pnpm build:packages && ...`. This ensures `@internationalota/shared` artifacts in `dist/` exist before workspace consumers lint, typecheck, or test against them.
  - *Evidence:* Fresh clone sequence `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes with exit code 0.
- **R2 — Prove NestJS wiring:**
  - *Change:* Added `@nestjs/testing` (`^12.4.2`) to `apps/api/package.json` devDependencies. Refactored `apps/api/src/health.controller.spec.ts` from direct controller instantiation to an HTTP integration test that creates a Nest testing module (`Test.createTestingModule`), starts the app on an ephemeral port (`await app.listen(0)`), calls `fetch(`${url}/health`)`, verifies HTTP 200 and `{ status: 'ok' }`, and closes the app. No supertest used.
  - *Evidence:* `apps/api test$ vitest run` runs `HealthController (HTTP) > GET /health returns 200 with { status: "ok" }` in 150ms passing.
- **R3 — Web typecheck must not depend on `.next/`:**
  - *Change:* Changed `apps/web/package.json` `"typecheck"` script to `"next typegen && tsc --noEmit"`. Removed `apps/web/next-env.d.ts` from git tracking and added `next-env.d.ts` to `.gitignore`. On fresh clones, `next typegen` automatically generates fresh route types before `tsc --noEmit` runs.
  - *Evidence:* Clean checkout typecheck succeeds without prior Next build.
- **R4 — Report honesty & fresh clone execution:**
  - *Change:* Executed the entire acceptance sequence in an isolated fresh clone directory (`/tmp/p1check`) cloned directly from the remote branch on GitHub.
  - *Evidence:* Real command output pasted verbatim in "Fresh Clone Verification Output" section below.
- **R5 — Remove `agentRules: false` from `next.config.mjs`:**
  - *Change:* Removed `agentRules: false` from `apps/web/next.config.mjs`. Added `AGENTS.md` to `.gitignore` so any Next.js 16 runtime file generation does not dirty the working directory.
  - *Evidence:* `next.config.mjs` only contains standard `transpilePackages: ['@internationalota/shared']`.
- **R6 — Delete `vitest.workspace.ts`:**
  - *Change:* Deleted `vitest.workspace.ts` from repository and removed its reference from `eslint.config.mjs` ignores.
  - *Evidence:* Tests continue running per-package cleanly via `pnpm -r run test` with no deprecation warnings.
- **R7 — Document `apps/api dev` reload limitation:**
  - *Change:* Explicitly documented in "Known limitations" that `apps/api dev` script runs `tsc && node dist/main.js` without watch/reload, in strict adherence to dependency constraints.
  - *Evidence:* Documented below in "Known limitations".
- **R8 — Remove fixed `container_name` in `docker-compose.yml`:**
  - *Change:* Removed `container_name: ota_postgres` and `container_name: ota_redis` from `docker-compose.yml`. Compose project `name: internationalota` automatically namespaces containers to `internationalota-postgres-1` and `internationalota-redis-1`.
  - *Evidence:* `docker compose config` and `docker compose up -d` succeed without hardcoded container names.

## Tests executed (exact commands):
1. `rm -rf /tmp/p1check && git clone -b task/P1-01-monorepo-skeleton https://github.com/thutniteso-eng/InternationalOTA.git /tmp/p1check && cd /tmp/p1check`
2. `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
3. `pnpm format:check`
4. `docker compose up -d`
5. `docker compose ps`
6. `API_PORT=4001 pnpm --filter @internationalota/api dev` & `curl -i http://localhost:4001/health`
7. `pnpm --filter @internationalota/web dev` & `curl -s http://localhost:3000`

## Fresh Clone Verification Output (real output from /tmp/p1check):

```
Cloning into '/tmp/p1check'...
remote: Enumerating objects: 93, done.        
remote: Counting objects: 100% (93/93), done.        
remote: Compressing objects: 100% (67/67), done.        
remote: Total 93 (delta 21), reused 89 (delta 17), pack-reused 0 (from 0)        
Receiving objects: 100% (93/93), 71.73 KiB | 1.56 MiB/s, done.
Resolving deltas: 100% (21/21), done.
Scope: all 4 workspace projects
Lockfile is up to date, resolution step is skipped
Packages: +293
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
node_modules/.pnpm/@swc+core@1.16.22_@swc+helpers@0.5.23/node_modules/@swc/core: Running postinstall script...
node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild: Running postinstall script...
node_modules/.pnpm/@swc+core@1.16.22_@swc+helpers@0.5.23/node_modules/@swc/core: Running postinstall script, done in 111ms
node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild: Running postinstall script, done in 96ms

devDependencies:
+ eslint 9.39.5
+ prettier 3.9.10
+ typescript 5.9.3
+ typescript-eslint 8.72.2
+ vitest 3.2.7

Done in 2.4s using pnpm v10.29.3

> internationalota@0.0.1 lint /tmp/p1check
> pnpm build:packages && pnpm -r run lint


> internationalota@0.0.1 build:packages /tmp/p1check
> pnpm --filter "./packages/**" build


> @internationalota/shared@0.0.1 build /tmp/p1check/packages/shared
> tsc

Scope: 3 of 4 workspace projects
packages/shared lint$ eslint .
└─ Done in 2.5s
apps/api lint$ eslint .
apps/web lint$ eslint .
└─ Done in 2.8s
└─ Done in 2.9s

> internationalota@0.0.1 typecheck /tmp/p1check
> pnpm build:packages && pnpm -r run typecheck


> internationalota@0.0.1 build:packages /tmp/p1check
> pnpm --filter "./packages/**" build


> @internationalota/shared@0.0.1 build /tmp/p1check/packages/shared
> tsc

Scope: 3 of 4 workspace projects
packages/shared typecheck$ tsc --noEmit
└─ Done in 1.1s
apps/api typecheck$ tsc --noEmit
apps/web typecheck$ next typegen && tsc --noEmit
│ Generating route types...
│ ✓ Types generated successfully
└─ Done in 1.4s
└─ Done in 2.3s

> internationalota@0.0.1 test /tmp/p1check
> pnpm build:packages && pnpm -r run test


> internationalota@0.0.1 build:packages /tmp/p1check
> pnpm --filter "./packages/**" build


> @internationalota/shared@0.0.1 build /tmp/p1check/packages/shared
> tsc

Scope: 3 of 4 workspace projects
packages/shared test$ vitest run
│  RUN  v3.2.7 /tmp/p1check/packages/shared
│  ✓ src/index.spec.ts (1 test) 6ms
│  Test Files  1 passed (1)
│       Tests  1 passed (1)
│    Start at  12:12:37
│    Duration  1.04s (transform 61ms, setup 0ms, collect 59ms, tests 6ms, environment 0ms, prepare 124ms)
└─ Done in 1.8s
apps/api test$ vitest run
apps/web test$ vitest run
│  RUN  v3.2.7 /tmp/p1check/apps/web
│  RUN  v3.2.7 /tmp/p1check/apps/api
│  ✓ src/app/page.spec.ts (1 test) 7ms
│  Test Files  1 passed (1)
│       Tests  1 passed (1)
│    Start at  12:12:39
│    Duration  1.63s (transform 194ms, setup 0ms, collect 118ms, tests 7ms, environment 0ms, prepare 133ms)
└─ Done in 2.5s
│  ✓ src/health.controller.spec.ts (1 test) 316ms
│  Test Files  1 passed (1)
│       Tests  1 passed (1)
│    Start at  12:12:39
│    Duration  2.63s (transform 294ms, setup 0ms, collect 922ms, tests 316ms, environment 0ms, prepare 148ms)
└─ Done in 3.4s

> internationalota@0.0.1 build /tmp/p1check
> pnpm -r run build

Scope: 3 of 4 workspace projects
packages/shared build$ tsc
└─ Done in 1.5s
apps/api build$ tsc -p tsconfig.build.json
apps/web build$ next build
│ ▲ Next.js 16.4.6 (Turbopack)
│ ✓ Running next.config.mjs took 29ms
│   Creating an optimized production build ...
└─ Done in 4.2s
│ ✓ Compiled successfully in 6.6s
│   Running TypeScript ...
│   Finished TypeScript in 4.3s ...
│   Collecting page data using 4 workers ...
│   Generating static pages using 4 workers (0/3) ...
│ ✓ Generating static pages using 4 workers (3/3) in 618ms
│   Finalizing page optimization ...
│ Route (app)
│ ┌ ○ /
│ └ ○ /_not-found
│ ○  (Static)  prerendered as static content
└─ Done in 13.6s
```

### Docker Compose Health (namespaced containers):
```
NAME                          IMAGE                    COMMAND                  SERVICE    CREATED         STATUS                   PORTS
internationalota-postgres-1   postgis/postgis:17-3.5   "docker-entrypoint.s…"   postgres   2 minutes ago   Up 2 minutes (healthy)   0.0.0.0:55432->5432/tcp, [::]:55432->5432/tcp
internationalota-redis-1      redis:7                  "docker-entrypoint.s…"   redis      2 minutes ago   Up 2 minutes (healthy)   0.0.0.0:56379->6379/tcp, [::]:56379->6379/tcp
```

### API HTTP Integration Test Output:
```
 ✓ src/health.controller.spec.ts (1 test) 316ms
   ✓ HealthController (HTTP) > GET /health returns 200 with { status: "ok" }
```

## Known limitations:
1. `apps/api` `dev` script: runs `tsc && node dist/main.js` without file watch/live reload. This avoids adding unapproved dev tooling dependencies (e.g. tsx, nodemon, @nestjs/cli) not listed in the task specification.
2. Port 4000 host collision: Port 4000 on `127.0.0.1` is pre-bound on this development host by an active system service (`aios-web.service` under user `aios`). The application code strictly respects `API_PORT` with a 4000 default; on hosts where 4000 is occupied, overriding `API_PORT=<port>` allows running without friction.

## Deviations from spec (and why):
- `@nestjs/testing` added as allowed dev dependency to implement R2 and verify NestJS DI, controller routing, and decorator metadata via HTTP `fetch` on port 0.
- `API_PORT=4001` was used during manual dev server verification due to host port 4000 collision with `aios-web`.

## Remaining risks:
None identified for monorepo skeleton. All workspace packages build, typecheck, lint, and test cleanly on fresh clone.
