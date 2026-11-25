# TASK P1-06 report

## Implemented

### 1. Prerequisite Tooling Upgrades (Approved by Claude, Commit 1: `fbeac15`)
- Upgraded `vitest` from `^3.0.5` to `^4.1.12` across all 6 workspace `package.json` files (`package.json`, `apps/api`, `apps/web`, `packages/db`, `packages/money`, `packages/time`) so `better-auth@1.7.28`'s optional `vitest` peerDependency no longer pulls `tinypool@1.1.1` (which had 2 critical advisories) into `pnpm audit --prod --audit-level high`.
- Upgraded `drizzle-kit` from `^0.30.5` to `^0.31.11` in `packages/db/package.json` (satisfying `better-auth@1.7.28`'s `>=0.31.4` peer range). Verified `pnpm db:generate` produced **no new migration** before adding the `identity` schema (`No schema changes, nothing to migrate 😴`).
- Added `tools/tsconfig.json` and simplified `eslint.config.mjs` (`projectService: true`) so `eslint tools` retains ES2022 `Set` lib types under Vitest 4.

### 2. Pinned Dependency
- `better-auth`: pinned to exact version **`1.7.28`** in `apps/api/package.json` (`"better-auth": "1.7.28"`). No other new runtime dependency was added.

### 3. Database Schema & Migration (`identity` schema)
- Added `packages/db/src/schema/identity.ts` using `pgSchema('identity')`:
  - Better Auth tables: `identity.user`, `identity.session`, `identity.account`, `identity.verification`, `identity.rate_limit`.
  - Our own authorization table: `identity.user_roles (user_id FK -> identity.user(id) ON DELETE CASCADE, role text CHECK (role IN ('customer','admin','operator','partner_admin','partner_staff')), created_at, PK(user_id, role))`.
- Generated forward-only migration `packages/db/migrations/0003_mixed_steel_serpent.sql`.
- Implemented `packages/db/src/grant-role.ts` (`grantRoleByEmail` + CLI entrypoint) exposed via `pnpm identity:grant-role <email> <role>`.

### 4. Identity Module (`apps/api/src/modules/identity/`)
- Public boundary (`index.ts`) exports ONLY our own domain API (`AuthGuard`, `CurrentPrincipal`, `Roles`, `RolesGuard`, `IdentityModule`, `IdentityService`, `EMAIL_SENDER`, `EmailSender`, `LogOnlyEmailSender`, `Principal`, `PrincipalKind`, `Role`, `AuthenticatedRequest`). Nothing from `better-auth` is re-exported.
- `IdentityService` (`identity.service.ts`) is the only file in the codebase that imports `better-auth`:
  - Validates `BETTER_AUTH_SECRET` (>= 32 chars) and refuses to start in `NODE_ENV=production` without a real `EmailSender` (fail fast).
  - Configures email + password auth only, Drizzle PostgreSQL adapter mapped to `identity.*` tables, DB-backed sessions, `HttpOnly` + `SameSite=Lax` + `Secure` (in production) cookies, `AUTH_TRUSTED_ORIGINS` from env, and DB-backed rate limiting (`storage: 'database'`, enabled explicitly, `/sign-in/email` max 5/60s, `/sign-up/email` max 10/60s).
  - `databaseHooks.user.create.after` automatically grants `'customer'` in `identity.user_roles` on sign-up.
- Added `no-better-auth-outside-identity` rule in `.dependency-cruiser.cjs` forbidding any file in `apps/api/src/` outside `apps/api/src/modules/identity/` from importing `better-auth`.

### 5. Body-Parser Handling for `/api/auth/*`
- Created `apps/api/src/app.setup.ts` (`configureApp(app)`), called from `main.ts` and test setups.
- NestJS is initialized with `{ bodyParser: false }` so NestJS does not register `express.json()` globally before Better Auth.
- `configureApp(app)` mounts `expressApp.all('/api/auth/{*splat}', identityService.getAuthHandler())` FIRST (Express 5 wildcard syntax) so Better Auth receives the raw unparsed request stream, then calls `httpAdapter.registerParserMiddleware()` to re-enable NestJS's built-in JSON and URL-encoded body parsers for all non-auth routes without adding any direct `express` runtime dependency.

### 6. Principal-Scoped Idempotency (`userId:` prefix) & H1 Same-Payload Fencing
- Updated `computeScope(req)` in `apps/api/src/modules/idempotency/hash.ts` to prefix `${principal.userId}:` when `req.principal?.userId` is attached by `AuthGuard`.
- Added unit test in `hash.spec.ts` and integration test AC9 in `identity.spec.ts`.
- Added **H1** same-payload fencing test in `apps/api/src/modules/idempotency/idempotency.spec.ts` (using a sequential gate queue in `test-idempotent-counter.controller.ts`) proving that when execution #2 takes over with the same key and same payload and is held `in_progress`, releasing stale execution #1 does not overwrite the `in_progress` row.

---

## Files created/modified/deleted

- **Created**:
  - `packages/db/src/schema/identity.ts`
  - `packages/db/src/grant-role.ts`
  - `packages/db/migrations/0003_mixed_steel_serpent.sql`
  - `packages/db/migrations/meta/0003_snapshot.json`
  - `apps/api/src/app.setup.ts`
  - `apps/api/src/modules/identity/identity.types.ts`
  - `apps/api/src/modules/identity/email-sender.interface.ts`
  - `apps/api/src/modules/identity/identity.service.ts`
  - `apps/api/src/modules/identity/auth.guard.ts`
  - `apps/api/src/modules/identity/current-principal.decorator.ts`
  - `apps/api/src/modules/identity/roles.decorator.ts`
  - `apps/api/src/modules/identity/roles.guard.ts`
  - `apps/api/src/modules/identity/test-identity.controller.ts`
  - `apps/api/src/modules/identity/identity.module.ts`
  - `apps/api/src/modules/identity/index.ts`
  - `apps/api/src/modules/identity/identity.spec.ts`
  - `tools/tsconfig.json`
  - `reports/TASK-P1-06-report.md`

- **Modified**:
  - `package.json`, `apps/api/package.json`, `apps/web/package.json`, `packages/db/package.json`, `packages/money/package.json`, `packages/time/package.json`, `pnpm-lock.yaml` (Vitest `^4.1.12`, drizzle-kit `^0.31.11`, `better-auth` exact `1.7.28`, `identity:grant-role` script)
  - `eslint.config.mjs` (`projectService: true` with `tools/tsconfig.json`)
  - `.dependency-cruiser.cjs` (`no-better-auth-outside-identity` rule)
  - `packages/db/src/index.ts`, `packages/db/src/schema/index.ts`, `packages/db/migrations/meta/_journal.json`
  - `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health.controller.spec.ts`
  - `apps/api/src/modules/idempotency/hash.ts`, `apps/api/src/modules/idempotency/hash.spec.ts`, `apps/api/src/modules/idempotency/test-idempotent-counter.controller.ts`, `apps/api/src/modules/idempotency/idempotency.spec.ts`

---

## Proof Outputs

### 1. `pnpm db:generate` after `drizzle-kit` 0.31.11 upgrade (before `identity` schema)
```
> @internationalota/db@0.0.1 db:generate /home/iteso/projects/InternationalOTA/packages/db
> drizzle-kit generate

No config path provided, using default 'drizzle.config.ts'
Reading config file '/home/iteso/projects/InternationalOTA/packages/db/drizzle.config.ts'
6 tables
app_meta 4 columns 0 indexes 0 fks
idempotency_keys 10 columns 0 indexes 0 fks
countries 6 columns 0 indexes 0 fks
currencies 7 columns 0 indexes 0 fks
languages 6 columns 0 indexes 0 fks
time_zones 4 columns 0 indexes 1 fks

No schema changes, nothing to migrate 😴
```

### 2. AC7 — Deliberate `dependency-cruiser` failure (importing `better-auth` in `apps/api/src/health.controller.ts`)
```
> internationalota@0.0.1 lint:boundaries /home/iteso/projects/InternationalOTA
> depcruise apps/api/src --config .dependency-cruiser.cjs


  error no-better-auth-outside-identity: apps/api/src/health.controller.ts → node_modules/.pnpm/better-auth@1.7.28_drizzle-kit@0.31.11_drizzle-orm@0.45.4_@types+pg@8.23.1_gel@2.2.1_ky_9b6beee29cf61a65517ba9b30739a79d/node_modules/better-auth/dist/index.mjs

x 1 dependency violations (1 errors, 0 warnings). 43 modules, 132 dependencies cruised.

ELIFECYCLE Command failed with exit code 1.
EXIT_CODE=1
```

### 3. H1 — Deliberate fencing mutation failure (removing `locked_until` predicate from completion `WHERE`)
```
 FAIL  src/modules/idempotency/idempotency.spec.ts > Idempotency module integration tests > H1: Same-payload fencing prevents stale execution #1 from overwriting in-progress takeover execution #2
AssertionError: expected 'completed' to be 'in_progress' // Object.is equality

Expected: "in_progress"
Received: "completed"

 ❯ src/modules/idempotency/idempotency.spec.ts:610:34
    608|       .from(idempotencyKeys)
    609|       .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.…
    610|     expect(rowAfterFirst?.state).toBe('in_progress');
       |                                  ^
    611|     expect(rowAfterFirst?.responseBody).toBeNull();
```

---

## Fresh-Clone Verification

Will be populated with real outputs from `/tmp/p1check-p106` immediately after pushing branch `task/P1-06-identity`.

---

## Known limitations

- Real email provider integration (SMTP/SES/Resend) is out of scope for P1-06; `LogOnlyEmailSender` is used in dev/test and production startup refuses to start unless a real `EmailSender` is provided.
- Social login, 2FA/passkeys, partner organizations, and frontend login UI are out of scope per spec.

## Deviations from spec (and why)

- Approved by Claude before implementation: upgraded `vitest` workspace-wide to `^4.1.12` and `drizzle-kit` to `^0.31.11` (Commit 1: `fbeac15`) to resolve the `pnpm audit --prod --audit-level high` critical findings on `tinypool@1.1.1` pulled via `better-auth`'s optional `vitest` peerDependency and satisfy `better-auth`'s `drizzle-kit >= 0.31.4` peer range.

## Remaining risks

- None. All acceptance criteria (AC1–AC10) and H1 are covered by deterministic integration tests on isolated temporary PostgreSQL databases.
