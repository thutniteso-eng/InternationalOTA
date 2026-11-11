# TASK-P1-01 report

## Implemented:
Created the complete, buildable monorepo skeleton for InternationalOTA:
- Pinned toolchain: Node.js 24 (.nvmrc) and pnpm 10 (.npmrc engine-strict=true).
- Root monorepo workspace configuration via `pnpm-workspace.yaml` (`apps/*`, `packages/*`).
- Root TypeScript configuration (`tsconfig.base.json`) enforcing `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Flat ESLint configuration (`eslint.config.mjs`) using `typescript-eslint` type-aware linting (`recommendedTypeChecked`), configured for Prettier compatibility.
- Prettier configuration (`.prettierrc`) with repo-wide code style checking.
- Root test runner with Vitest workspace (`vitest.workspace.ts`).
- Docker Compose configuration (`docker-compose.yml`) running PostgreSQL 17 with PostGIS (`postgis/postgis:17-3.5`) on port 55432 and Redis 7 (`redis:7`) on port 56379 with named volumes and healthchecks.
- Environment variable specification in `.env.example`.
- `@internationalota/shared`: Pure TypeScript library exporting `PlatformInfo` interface and `formatPlatformGreeting` helper with accompanying unit test.
- `@internationalota/api`: NestJS application with graceful shutdown hooks, `HealthController` exposing `GET /health` returning `{"status":"ok"}`, unit tests using Vitest and `unplugin-swc` with decorator metadata.
- `@internationalota/web`: Next.js 16 (App Router, TypeScript) application rendering greeting text from `@internationalota/shared` to demonstrate workspace linking.
- Updated `README.md` with complete local development instructions.

## Installed Versions:
- Node.js: `v24.22.2`
- pnpm: `10.29.3`
- NestJS (@nestjs/core, @nestjs/common, @nestjs/platform-express): `12.4.2`
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
- `vitest.workspace.ts`
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
- `apps/web/next-env.d.ts`
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
- `README.md`

Deleted:
- None

## Technical decisions made:
1. Allow-listed `@swc/core` and `esbuild` in `package.json#pnpm.onlyBuiltDependencies` to satisfy pnpm 10 security defaults while enabling native compilation for SWC and Vite/Vitest.
2. Integrated `unplugin-swc` into `apps/api/vitest.config.ts` with `swc.vite()` to properly transform NestJS decorator metadata during Vitest execution.
3. Created `apps/api/tsconfig.build.json` extending `tsconfig.json` with exclusion for `src/**/*.spec.ts` to ensure production builds contain only runtime code.
4. Used `typescript-eslint` v8 `recommendedTypeChecked` configuration in `eslint.config.mjs` without stylistic rules so that ESLint and Prettier work harmoniously without conflicts.
5. Set `agentRules: false` in `apps/web/next.config.mjs` to keep the workspace free of Next.js 16 auto-generated root markers.

## Tests executed (exact commands):
1. `corepack enable && pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`
6. `pnpm format:check`
7. `docker compose up -d`
8. `docker compose ps`
9. `pnpm --filter @internationalota/api dev`
10. `API_PORT=4001 pnpm --filter @internationalota/api dev` & `curl -i http://localhost:4001/health`
11. `pnpm --filter @internationalota/web dev` & `curl -s http://localhost:3000`

## Actual results (paste output summary):

### 1. `corepack enable && pnpm install --frozen-lockfile`
```
Scope: all 4 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 873ms using pnpm v10.29.3
```

### 2. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`
```
> internationalota@0.0.1 lint /home/iteso/projects/InternationalOTA
> pnpm -r run lint

Scope: 3 of 4 workspace projects
packages/shared lint$ eslint .
└─ Done in 1.2s
apps/api lint$ eslint .
└─ Done in 1.7s
apps/web lint$ eslint .
└─ Done in 2.1s

> internationalota@0.0.1 typecheck /home/iteso/projects/InternationalOTA
> pnpm -r run typecheck

Scope: 3 of 4 workspace projects
packages/shared typecheck$ tsc --noEmit
└─ Done in 671ms
apps/api typecheck$ tsc --noEmit
└─ Done in 1s
apps/web typecheck$ tsc --noEmit
└─ Done in 1.3s

> internationalota@0.0.1 test /home/iteso/projects/InternationalOTA
> pnpm -r run test

Scope: 3 of 4 workspace projects
packages/shared test$ vitest run
 ✓ src/index.spec.ts (1 test) 2ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
└─ Done in 713ms
apps/web test$ vitest run
 ✓ src/app/page.spec.ts (1 test) 3ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
└─ Done in 1s
apps/api test$ vitest run
 ✓ src/health.controller.spec.ts (1 test) 3ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
└─ Done in 1.2s

> internationalota@0.0.1 build /home/iteso/projects/InternationalOTA
> pnpm -r run build

Scope: 3 of 4 workspace projects
packages/shared build$ tsc
└─ Done in 722ms
apps/api build$ tsc -p tsconfig.build.json
└─ Done in 900ms
apps/web build$ next build
▲ Next.js 16.4.6 (Turbopack)
✓ Running next.config.mjs took 17ms
✓ Compiled successfully in 122ms
✓ Finished TypeScript in 1409ms
✓ Generating static pages using 4 workers (3/3) in 338ms
└─ Done in 3.2s

> internationalota@0.0.1 format:check /home/iteso/projects/InternationalOTA
> pnpm -r run format:check

Scope: 3 of 4 workspace projects
packages/shared format:check$ prettier --check src
All matched files use Prettier code style!
apps/api format:check$ prettier --check src
All matched files use Prettier code style!
apps/web format:check$ prettier --check src
All matched files use Prettier code style!
```

### 3. `docker compose ps`
```
NAME           IMAGE                    COMMAND                  SERVICE    CREATED         STATUS                   PORTS
ota_postgres   postgis/postgis:17-3.5   "docker-entrypoint.s…"   postgres   2 minutes ago   Up 2 minutes (healthy)   0.0.0.0:55432->5432/tcp, [::]:55432->5432/tcp
ota_redis      redis:7                  "docker-entrypoint.s…"   redis      2 minutes ago   Up 2 minutes (healthy)   0.0.0.0:56379->6379/tcp, [::]:56379->6379/tcp
```

### 4. API Dev Server & Health Endpoint
On default port 4000:
```
[Nest] 317315  - 11/11/2026, 8:19:01 AM     LOG [NestFactory] Starting Nest application...
[Nest] 317315  - 11/11/2026, 8:19:01 AM     LOG [InstanceLoader] AppModule dependencies initialized +7ms
[Nest] 317315  - 11/11/2026, 8:19:01 AM     LOG [RoutesResolver] HealthController {/health}: +4ms
[Nest] 317315  - 11/11/2026, 8:19:01 AM     LOG [RouterExplorer] Mapped {/health, GET} route +3ms
[Nest] 317315  - 11/11/2026, 8:19:01 AM     LOG [NestApplication] Nest application successfully started +1ms
[Nest] 317315  - 11/11/2026, 8:19:01 AM   ERROR [NestApplication] Error: listen EADDRINUSE: address already in use :::4000 +2ms
```
When running with `API_PORT=4001`:
```
[Nest] 317434  - 11/11/2026, 8:19:09 AM     LOG [NestFactory] Starting Nest application...
[Nest] 317434  - 11/11/2026, 8:19:09 AM     LOG [InstanceLoader] AppModule dependencies initialized +7ms
[Nest] 317434  - 11/11/2026, 8:19:09 AM     LOG [RoutesResolver] HealthController {/health}: +5ms
[Nest] 317434  - 11/11/2026, 8:19:09 AM     LOG [RouterExplorer] Mapped {/health, GET} route +2ms
[Nest] 317434  - 11/11/2026, 8:19:09 AM     LOG [NestApplication] Nest application successfully started +1ms
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 15
ETag: W/"f-VaSQ4oDUiZblZNAEkkN+sX+q3Sg"
Date: Wed, 11 Nov 2026 01:19:10 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"status":"ok"}
```

### 5. Web Dev Server & Shared Linking
```
▲ Next.js 16.4.6 (Turbopack)
- Local:         http://localhost:3000
- Network:       http://172.28.161.90:3000
✓ Ready in 267ms
✓ Running next.config.mjs took 19ms
```
HTML rendered on `http://localhost:3000`:
```
InternationalOTA — Modern Independent Travel Platform
```

## Known limitations:
Port 4000 on `127.0.0.1` is pre-bound on this development host by an active system service (`aios-web.service` under user `aios`). The application code strictly respects `API_PORT` with a 4000 default; on hosts where 4000 is occupied, overriding `API_PORT=<port>` allows running without friction.

## Deviations from spec (and why):
None in the codebase, architecture, or dependencies. To verify API runtime execution on this host without interfering with existing host services, `API_PORT=4001` was used during the dev server curl test.

## Remaining risks:
Port collisions on developer machines if other local services are already bound to port 4000. Mitigated by configurable `API_PORT` in `.env.example` and documented in `README.md`.
