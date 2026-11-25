# TASK P1-06 — Identity & access (Better Auth behind our own module)

## OBJECTIVE
Customers and staff can sign up / sign in with sessions stored in our own PostgreSQL; the API can require an authenticated principal and a role. Authentication is delegated to Better Auth; **authorization (roles) and the public interface stay ours**, so the library can be replaced later by changing one module.

## BACKGROUND
Decision D-007 = Better Auth (Owner, 2026-11-12) with three safeguards: (1) wrapped behind `apps/api/src/modules/identity/`, (2) user data in our DB, (3) exact version pin. Depends on P1-07 being merged (`common/http` problem+json filter, idempotency scope). Read: `docs/ENGINEERING_STANDARDS.md`, `docs/DECISIONS.md` (D-007).

## SCOPE
1. Dependency: `better-auth` pinned to an **exact** version (no `^`/`~`), latest stable 1.x at implementation time; record it in the report. No other new runtime dependency.
2. Module `apps/api/src/modules/identity/` with `index.ts` exporting only our own API:
   - `AuthGuard` (401 problem+json when no valid session), `@CurrentPrincipal()` param decorator returning our own type `Principal = { userId: string; kind: 'customer' | 'staff' | 'partner'; roles: Role[] }`.
   - `@Roles(...roles)` + `RolesGuard` (403 problem+json).
   - Nothing from `better-auth` is re-exported; no other module may import `better-auth` (add a `dependency-cruiser` rule enforcing this).
3. Tables in PostgreSQL schema **`identity`** (Drizzle `pgSchema('identity')`, generated migration), mapped into Better Auth's Drizzle adapter. Library tables (user, session, account, verification, rate limit) live there.
4. **Our own authorization table** `identity.user_roles (user_id FK, role text CHECK in ('customer','admin','operator','partner_admin','partner_staff'), created_at, PK(user_id, role))`. New sign-ups get `customer`. Staff roles are granted only by a seed/CLI script for now (`pnpm identity:grant-role <email> <role>`), never via public API.
5. Better Auth configuration:
   - Email + password only (social login later). Email verification and password-reset emails go through an `EmailSender` interface; in dev/test a log-only implementation; in `NODE_ENV=production` the app must **refuse to start** if no real sender is configured.
   - DB-backed sessions; cookies `HttpOnly`, `Secure` (except local dev over http), `SameSite=Lax`.
   - `BETTER_AUTH_SECRET` (≥ 32 chars) and `AUTH_TRUSTED_ORIGINS` from env; missing/short secret → startup fails (fail fast, like D1).
   - Built-in rate limiting enabled with **database** storage (not memory) for sign-in/sign-up.
   - Auth routes mounted under `/api/auth/*` in the NestJS/Express app. Watch the known pitfall: the auth handler must receive the raw request before NestJS's JSON body parser consumes it — document how this was solved.
6. Idempotency scope: when a principal is present, prefix the P1-07 scope with `userId:`.

## OUT OF SCOPE
Social login, 2FA/passkeys (plugins later), partner organizations (Phase 4), frontend login pages, real email provider integration.

## ACCEPTANCE CRITERIA (integration tests, isolated temp database as required by P1-07 G4)
1. Sign up → sign in → session cookie → protected test endpoint returns the `Principal` with role `customer`.
2. No/invalid/expired session → 401 problem+json; after sign-out the old cookie → 401.
3. `@Roles('admin')` endpoint: customer → 403; after `identity:grant-role` admin → 200.
4. **Cross-account:** user A cannot read user B's resource on a test endpoint `GET /__test/users/:id/private` (403), proven both ways.
5. Rate limit: repeated wrong passwords → 429 within the configured window; limit state persisted in DB (proved by restarting the app inside the test or by inspecting the table).
6. Startup fails with a clear error when `BETTER_AUTH_SECRET` is missing or < 32 chars, and in production mode without an email sender.
7. `dependency-cruiser` fails if any file outside `modules/identity/` imports `better-auth` (show the deliberate failure).
8. Passwords are never stored or logged in plain text (assert on DB row + captured logs).
9. Idempotency scope includes `userId:` for authenticated requests (test).
10. Fresh clone + CI green; `licenses:check` passes.

## DELIVERABLES
Branch `task/P1-06-identity`, PR `[P1-06] Identity & access`, report `reports/TASK-P1-06-report.md` including the pinned better-auth version and how the body-parser issue was handled.

## ADDITIONAL ITEM (carried from P1-07 review, H1)
In `apps/api/src/modules/idempotency/idempotency.spec.ts` add a fencing test where the takeover execution uses the **same** payload: execution #1 (gated) → expire its lock → execution #2 with the same key and same body takes over and is itself held in progress → release #1 → assert the row is still `in_progress` (not overwritten with #1's response) → release #2 → row stores #2's response. Prove it fails when the `locked_until` token condition is removed from the completion `WHERE` (paste output).
