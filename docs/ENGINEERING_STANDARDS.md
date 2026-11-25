# Engineering Standards (v1, 2026-11-11)

## Toolchain
- Node.js 24 LTS (pinned in `.nvmrc`), pnpm 10 via Corepack, TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Monorepo: `apps/*` (deployables), `packages/*` (libraries). Root scripts: `lint`, `typecheck`, `test`, `build`.
- Tests: Vitest everywhere. Unit tests beside code (`*.spec.ts`); integration tests in `test/` and run against real PostgreSQL (never mocks for DB behaviour).
- Line endings LF (`.gitattributes`). Code lives inside WSL filesystem, not `/mnt/c`.

## Code rules
- No `any` without an inline justification comment. No floats for money.
- Money: `bigint` minor units + ISO 4217 code. Time: `timestamptz` in UTC + IANA zone of the service location where relevant; service dates as `date` (local).
- IDs: UUIDv7, generated in application code.
- DB naming: snake_case tables/columns; one PostgreSQL schema per module (`identity`, `catalog`, `inventory`, `pricing`, `booking`, `payment`, `finance`, ...). Migrations are forward-only (see D-011).
- A module exposes only `src/modules/<name>/index.ts`; other modules must not import its internals or query its tables.
- Every mutating HTTP endpoint accepts `Idempotency-Key` (from P1-07 on).
- Errors: typed domain errors → mapped to RFC 9457 problem+json at the HTTP edge.
- Secrets only via environment; `.env` never committed; `.env.example` documents every variable.

## Dependencies
New runtime dependency = must be named in the task spec or approved by Claude. Allowed licences: MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, MPL-2.0 (file-level). GPL/AGPL/SSPL/unknown = blocked by CI.

## Git
- Branch per task: `task/P1-01-monorepo-skeleton`. PR title: `[P1-01] <summary>`.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- Merges: Claude squash-merges PRs it marked ACCEPTED once required checks are green (D-016); never bypass branch protection.

## Local ports (chosen to avoid clashing with other projects)
web 3000 · api 4000 · PostgreSQL 55432 · Redis 56379
