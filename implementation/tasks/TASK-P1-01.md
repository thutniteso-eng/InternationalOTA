# TASK P1-01 — Monorepo skeleton

## OBJECTIVE
Create the empty, buildable monorepo that every later task builds on: NestJS API, Next.js web, a shared TypeScript package, local Docker services.

## BACKGROUND
Read first: `CLAUDE.md`, `docs/ENGINEERING_STANDARDS.md`, `docs/SOLUTION_ARCHITECTURE.md` (stack table only). No business features exist yet.

## SCOPE (create)
```
.nvmrc                      # 24
.npmrc                      # engine-strict=true
package.json                # private root, packageManager pnpm@10.x, engines node >=24
pnpm-workspace.yaml         # apps/*, packages/*
tsconfig.base.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
eslint.config.mjs           # flat config, typescript-eslint (type-aware), prettier compatible
.prettierrc
vitest.workspace.ts (or vitest projects config)
docker-compose.yml          # postgres (postgis/postgis:17-3.5) on 55432, redis:7 on 56379, named volumes, healthchecks
.env.example
apps/api/                   # NestJS (latest stable major), port 4000, GET /health -> {"status":"ok"}
apps/web/                   # Next.js (latest stable, App Router, TypeScript), port 3000, one placeholder page
packages/shared/            # pure TS library, exports one example type + function, no runtime deps
README.md                   # update "Local development" section with exact commands
```

## OUT OF SCOPE
Database access/ORM (P1-03), CI (P1-02), auth, any business module, UI design, Kubernetes/cloud infra. Do not modify `docs/` except README.md and your report.

## TECHNICAL INSTRUCTIONS
1. Use Corepack for pnpm. Commit `pnpm-lock.yaml`.
2. Root scripts: `lint`, `typecheck`, `test`, `build`, `format:check` — each runs across all workspaces (`pnpm -r`).
3. API: Vitest with `unplugin-swc` (decorator metadata) for NestJS; health controller + its unit test. Read port from `API_PORT` env (default 4000). Enable graceful shutdown hooks.
4. Web: minimal page "InternationalOTA" rendering text from `@internationalota/shared` to prove workspace linking.
5. Package names: `@internationalota/api`, `@internationalota/web`, `@internationalota/shared`.
6. Docker compose: services `postgres` (db `ota_dev`, user/password from `.env`), `redis`. No app containers yet.
7. pnpm 10 blocks dependency lifecycle scripts by default: only allow-list builds that are strictly required (list them in the report).
8. Allowed new dependencies: nestjs core packages, next, react, react-dom, typescript, typescript-eslint, eslint, prettier, vitest, unplugin-swc, @swc/core, @types/*. Anything else → stop and ask.

## ACCEPTANCE CRITERIA
- Fresh clone in WSL: `corepack enable && pnpm install --frozen-lockfile` succeeds.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check` all exit 0.
- `docker compose up -d` → both services `healthy` (`docker compose ps`).
- `pnpm --filter @internationalota/api dev` → `curl localhost:4000/health` returns `{"status":"ok"}`.
- `pnpm --filter @internationalota/web dev` → `localhost:3000` shows the shared text.
- No secrets committed; `.env.example` lists every variable used.

## TEST REQUIREMENTS
Run every command in Acceptance Criteria and paste the tail of each output into the report.

## DELIVERABLES
Branch `task/P1-01-monorepo-skeleton`, one PR titled `[P1-01] Monorepo skeleton`, report at `reports/TASK-P1-01-report.md` (template in `docs/ANTIGRAVITY_PROTOCOL.md`), including exact versions installed (node, pnpm, nest, next, typescript, postgres image).
