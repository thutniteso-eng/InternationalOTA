# TASK P1-12 Report — Staging environment on WSL + Cloudflare quick tunnel (+ carry-overs)

## Live Staging Endpoint (AC10)

- **Live Public URL:** `https://eligible-brandon-strengths-viewing.trycloudflare.com`
- **Health endpoint (no basic auth required):** `https://eligible-brandon-strengths-viewing.trycloudflare.com/api/health/ready` (`HTTP 200 {"status":"ok","database":"connected"}`)
- **Edge protection:** Basic Auth required at Caddy for `/` (`/vi`, `/en`) and `/api/*` (except `/api/health*` and `/webhooks/*`); credentials stored in `deploy/staging/.env.staging` (`chmod 600`, git-ignored, never committed).

---

## Summary of Changes

### A. Runtime Environments (`APP_ENV`)

- Added `APP_ENVS`, `AppEnv`, and `resolveAppEnv()` in `packages/shared/src/index.ts` (`local | test | staging | production`, independent of `NODE_ENV`).
- Staging and production both run with `NODE_ENV=production`.
- `APP_ENV=production` still refuses startup without a real `EmailSender`; `APP_ENV=staging` permits `LogOnlyEmailSender` and emits a structured WARN (`staging_log_only_email_sender`).
- Updated `packages/i18n/src/translate.ts` (`isNonFatalMissingKeyEnv`) and `apps/api/src/common/observability/logger.ts` (`appEnv` base field, `pino-pretty` disabled in staging/production).

### B. Deployment Stack (`deploy/staging/` & `scripts/`)

- **`deploy/staging/compose.yml`**:
  - Pinned images only (no `latest`): `postgis/postgis:17-3.5`, `caddy:2.11.9-alpine`, `cloudflare/cloudflared:2026.11.2`, and multi-stage `node:24.22.3-alpine` Dockerfiles (`Dockerfile.api`, `Dockerfile.web`, running as non-root `ota` UID 1001).
  - Network isolation: `cloudflared` and `caddy` share `tunnel_net`; `caddy` (`172.29.10.10`), `api`, `web`, `migrate`, and `postgres` share `app_net` (`internal: true`). Zero host port bindings on `postgres`, `api`, or `web`.
- **`deploy/staging/Caddyfile`**:
  - Routes `/api/health*` (stripped to `/health*`) and `/webhooks/*` directly to `api:4000` without Basic Auth.
  - Protects all other paths with Caddy `basic_auth` (`header_up -Authorization` before proxying `/api/auth*` → `api:4000`, `/api/*` → `api:4000`, `/` → `web:3000`) and injects `X-Proxy-Secret` + `X-Forwarded-Proto: https`.
- **`deploy/staging/postgres-init.sh`**: Creates `ota_owner` and `ota_app` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`), creates `ota_staging` owned by `ota_owner`, installs `postgis`, revokes `CREATE` on database/public schema from `ota_app`, and rejects connections from the Docker bridge host gateway (`172.29.10.1/32`) in `pg_hba.conf`.
- **Operational scripts & guide**:
  - `scripts/staging-up.sh`: Generates `deploy/staging/.env.staging` (`chmod 600`) on first run, starts `cloudflared`, reads the assigned `https://*.trycloudflare.com` URL, updates `PUBLIC_BASE_URL` / `BETTER_AUTH_URL` / `AUTH_TRUSTED_ORIGINS`, builds and starts `postgres`, runs `migrate`, starts `api`/`web`/`caddy`, verifies `/api/health/ready`, and prints the URL and basic-auth username.
  - `scripts/staging-down.sh`: Stops containers cleanly while preserving `staging_postgres_data` and `.env.staging`.
  - `scripts/staging-backup.sh`: Runs `pg_dump --format=custom` into `~/ota-backups/` (timestamped, chmod `600`, retaining last 7 dumps).
  - `scripts/staging-restore.sh <file> [--replace]`: Restores into a new verification DB by default and compares row counts; requires explicit `--replace` to replace the live DB.
  - `deploy/staging/README.vi.md`: Vietnamese operational runbook for start, stop, backup, and restore.

### C. Closed Carry-overs

1. **L1 (`apps/api/src/common/http/client-ip.ts`, `app.setup.ts`, `identity.service.ts`):**
   - `resolveClientIp` trusts `CF-Connecting-IP` (or rightmost untrusted hop of `X-Forwarded-For`) **only** when both `req.socket.remoteAddress` matches `TRUSTED_PROXY_CIDRS` (`172.29.10.10/32`, Caddy's static IP) **and** `X-Proxy-Secret` matches `PROXY_SHARED_SECRET` in constant time.
   - Express `trust proxy` uses the same CIDR check; Better Auth reads client IPs exclusively from internal header `x-resolved-client-ip` (stripped on ingress).
2. **L2 (`identity.service.ts`):** Outside `local`/`test`, startup fails fast without a valid `PUBLIC_BASE_URL` (or `BETTER_AUTH_URL`) and non-empty `AUTH_TRUSTED_ORIGINS`.
3. **L3 (`identity.service.ts`):** Better Auth `useSecureCookies` and `defaultCookieAttributes.secure` derive strictly from `publicBaseUrl.protocol === 'https:'` (independent of `NODE_ENV`).
4. **P1-09 roles (`packages/db/src/roles.ts`, `apps/api/src/scripts/staging-migrate.ts`, `job-queue.service.ts`):**
   - `migrate` runs as `ota_owner` (migrations + seed + `pg-boss` schema & pre-created queues `outbox-relay`, `inbox-relay`, `idempotency-keys-cleanup`), then calls `applyRuntimeRoleGrants(db, 'ota_app')`.
   - `api` runs as `ota_app` with `PG_BOSS_MIGRATE=false` (`migrate: false, createSchema: false` in `PgBoss`).
   - **Documented `pgboss` privileges for `ota_app`:** `USAGE` on schema `pgboss`, `SELECT/INSERT/UPDATE/DELETE` on all tables in `pgboss`, `USAGE` on sequences in `pgboss`, and `EXECUTE` on functions in `pgboss`. No ownership or DDL privileges are required on any schema (pre-creating the 3 non-partitioned queues in `migrate` ensures `pgboss.create_queue` returns cleanly at runtime without `CREATE TABLE`).
5. **I1 (`packages/i18n/src/format-money.ts`, `packages/i18n/test/i18n.spec.ts`):** Removed `ISO_EXTRA_CURRENCY_EXPONENTS` and `FormattableMoney`; `formatMoney` strictly accepts supported `Money` (`@internationalota/money`), with KWD tests replaced by JPY and KRW (`9007199254740993n` tested for VND, USD, JPY).
6. **I2 (`apps/api/src/common/http/problem-details.filter.ts` + throw sites):** Removed `matchOwnedHttpErrorMessage` string matching; all owned HTTP exceptions (`AuthGuard`, `RolesGuard`, `TestIdentityController`, `IdempotencyInterceptor`, `InboxService`, `TestHmacWebhookVerifier`) throw with explicit `i18nKey` (and `i18nParams`).

---

## Acceptance Criteria Evidence (Real Outputs)

### AC1 — Public Tunnel, Basic Auth Gate, Web Rendering, and `/api/health/ready`

```text
=== AC1: Tunnel URL = https://knight-begin-bidder-rights.trycloudflare.com ===
GET /vi (no auth) -> HTTP 401
--- Unauthenticated GET /api/health/ready ---
{"status":"ok","database":"connected"}
HTTP 200
--- Authenticated GET /vi ---
<html lang="vi">
<link rel="alternate" hrefLang="en" href="/en"/>
<link rel="alternate" hrefLang="vi" href="/vi"/>
<link rel="alternate" hrefLang="x-default" href="/vi"/>
Nền tảng du lịch độc lập hiện đại
--- Authenticated GET /en ---
<html lang="en">
<link rel="alternate" hrefLang="en" href="/en"/>
<link rel="alternate" hrefLang="vi" href="/vi"/>
<link rel="alternate" hrefLang="x-default" href="/vi"/>
Modern Independent Travel Platform
```

### AC2 — Sign-Up & Sign-In Through Tunnel + Cookie Attributes

```text
=== AC2: Sign-up & Sign-in through tunnel URL ===
HTTP/2 200
set-cookie: __Secure-better-auth.session_token=<redacted>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
{"token":"PJxVKnsrRgIWWP30Jt2YHn7LgacH3Ccu","user":{"name":"Staging Owner","email":"staging-owner@example.com","emailVerified":false,"image":null,"createdAt":"2026-11-25T20:49:23.053Z","updatedAt":"2026-11-25T20:49:23.053Z","id":"v5Vp16VLsYX1d8Rqq1ZNJp1Wnokx9TOR"}}
--- Sign-in Set-Cookie flags ---
HTTP/2 200
set-cookie: __Secure-better-auth.session_token=<redacted>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
"ipAddress":"171.243.59.162"
"email":"staging-owner@example.com"
```

### AC3 (L1) — Real Client IP Rate Limiting & Rejection of Forged Direct Headers

```text
=== AC3 (L1): Direct-to-API forged headers vs tunnel rate limit ===
direct attempt 1 (forged XFF=198.51.100.1, CF=203.0.113.1) -> status=401
direct attempt 2 (forged XFF=198.51.100.2, CF=203.0.113.2) -> status=401
direct attempt 3 (forged XFF=198.51.100.3, CF=203.0.113.3) -> status=401
direct attempt 4 (forged XFF=198.51.100.4, CF=203.0.113.4) -> status=401
direct attempt 5 (forged XFF=198.51.100.5, CF=203.0.113.5) -> status=401
direct attempt 6 (forged XFF=198.51.100.6, CF=203.0.113.6) -> status=429
tunnel attempt 1 -> status=401
tunnel attempt 2 -> status=401
tunnel attempt 3 -> status=401
tunnel attempt 4 -> status=401
tunnel attempt 5 -> status=429
tunnel attempt 6 -> status=429
              key              | count
-------------------------------+-------
 127.0.0.1|/sign-in/email      |     5
 171.243.59.162|/get-session   |     1
 171.243.59.162|/sign-in/email |     5
 171.243.59.162|/sign-up/email |     1
(4 rows)
```

### AC4 (L2) — Refusal to Start With `APP_ENV=staging` and Empty `AUTH_TRUSTED_ORIGINS`

```text
=== AC4 (L2): API refuses startup with APP_ENV=staging and empty AUTH_TRUSTED_ORIGINS ===
{"level":"info","time":"2026-11-25T20:49:30.165Z","service":"api","env":"production","appEnv":"staging","context":"NestFactory","msg":"Starting Nest application..."}
{"level":"warn","time":"2026-11-25T20:49:30.182Z","service":"api","env":"production","appEnv":"staging","context":"IdentityService","level":"warn","event":"staging_log_only_email_sender","appEnv":"staging","message":"Starting in APP_ENV=staging with LogOnlyEmailSender; emails will be logged only and not delivered.","msg":"staging_log_only_email_sender"}
{"level":"info","time":"2026-11-25T20:49:30.182Z","service":"api","env":"production","appEnv":"staging","context":"InstanceLoader","msg":"DatabaseModule dependencies initialized"}
{"level":"error","time":"2026-11-25T20:49:30.183Z","service":"api","env":"production","appEnv":"staging","context":"ExceptionHandler","err":{"type":"Error","message":"AUTH_TRUSTED_ORIGINS must be non-empty when APP_ENV=staging.","stack":"Error: AUTH_TRUSTED_ORIGINS must be non-empty when APP_ENV=staging.\n    at new IdentityService (file:///app/apps/api/dist/modules/identity/identity.service.js:162:23) ..."},"msg":"error"}
```

### AC5 — P1-09 Non-Owner DB Role (`ota_app`) Denied DDL & `TRUNCATE` + Staging EmailSender WARN

```text
=== AC5: P1-09 DB roles as ota_app (DDL & TRUNCATE denied) ===
ERROR:  must be owner of table journal_lines
ERROR:  permission denied for schema public
LINE 1: CREATE TABLE public.x(i int);
                     ^
ERROR:  permission denied for table journal_lines
--- APP_ENV=staging WARN on LogOnlyEmailSender ---
api-1  | {"level":"warn","time":"2026-11-25T20:48:55.468Z","service":"api","env":"production","appEnv":"staging","context":"IdentityService","level":"warn","event":"staging_log_only_email_sender","appEnv":"staging","message":"Starting in APP_ENV=staging with LogOnlyEmailSender; emails will be logged only and not delivered.","msg":"staging_log_only_email_sender"}
```

### AC6 — Postgres Not Reachable From Host (`docker compose ps` + Rejected Host Attempts)

```text
=== AC6: Postgres not reachable from host ===
NAME                                     IMAGE                              COMMAND                  SERVICE       CREATED          STATUS                    PORTS
internationalota-staging-api-1           internationalota-staging-api       "docker-entrypoint.s…"   api           39 seconds ago   Up 39 seconds (healthy)   4000/tcp
internationalota-staging-caddy-1         caddy:2.11.9-alpine                "caddy run --config …"   caddy         39 seconds ago   Up 27 seconds             80/tcp, 443/tcp, 2019/tcp, 443/udp
internationalota-staging-cloudflared-1   cloudflare/cloudflared:2026.11.2   "cloudflared tunnel …"   cloudflared   56 seconds ago   Up 55 seconds
internationalota-staging-postgres-1      postgis/postgis:17-3.5             "docker-entrypoint.s…"   postgres      48 seconds ago   Up 47 seconds (healthy)   5432/tcp
internationalota-staging-web-1           internationalota-staging-web       "docker-entrypoint.s…"   web           39 seconds ago   Up 33 seconds (healthy)   3000/tcp
--- HostPort bindings ---
{}
host 127.0.0.1:5432 rejected -> 28P01 - password authentication failed for user "ota_app"
container bridge IP:5432 rejected -> 28000 - pg_hba.conf rejects connection for host "172.29.10.1", user "ota_app", database "ota_staging", no encryption
```

### AC7 — Backup & Restore Into New Database (Matching Row Counts)

```text
=== AC7: Backup & restore into new DB (row counts match) ===
Creating custom-format pg_dump of ota_staging -> /home/iteso/ota-backups/ota_staging_20261125T204932Z.dump...
-rw------- 1 iteso iteso 110K Nov 26 03:49 /home/iteso/ota-backups/ota_staging_20261125T204932Z.dump
Restoring /home/iteso/ota-backups/ota_staging_20261125T204932Z.dump into new verification database 'ota_restore_20261125_204933' (live DB 'ota_staging' untouched)...
CREATE DATABASE

=== Live database (ota_staging) row counts ===
table_name	row_count
finance.accounts	10
finance.journal_entries	0
identity.user	1
reference.currencies	179
reference.languages	5
(5 rows)

=== Restored database (ota_restore_20261125_204933) row counts ===
table_name	row_count
finance.accounts	10
finance.journal_entries	0
identity.user	1
reference.currencies	179
reference.languages	5
(5 rows)
```

### AC8 — Restart (`staging-down.sh` → `staging-up.sh`), New URL & Persisted Data

```text
Old URL: https://knight-begin-bidder-rights.trycloudflare.com
New URL: https://eligible-brandon-strengths-viewing.trycloudflare.com
Verified URL changed on restart.
--- Previous user signs in through NEW URL ---
HTTP/2 200
set-cookie: __Secure-better-auth.session_token=<redacted>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
{"redirect":false,"token":"eNbyTKh4tofe7wDg1zxAF5AofOUtQqUO","user":{"name":"Staging Owner","email":"staging-owner@example.com","emailVerified":false,"image":null,"createdAt":"2026-11-25T20:49:23.053Z","updatedAt":"2026-11-25T20:49:23.053Z","id":"v5Vp16VLsYX1d8Rqq1ZNJp1Wnokx9TOR"}}
--- /api/health/ready on NEW URL ---
{"status":"ok","database":"connected"}
HTTP 200
```

### AC9 — CI & Fresh-Clone Verification

- `pnpm format:check`: passed
- `pnpm lint`: passed
- `pnpm lint:boundaries`: passed (85 modules, 288 dependencies cruised, 0 violations)
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm test`: all workspace unit + integration tests passed (including I1, I2, L1, L2, L3)
- `pnpm licenses:check`: passed (`✅ All 471 package licenses verified successfully.`)
- `pnpm audit --prod --audit-level high`: passed (0 high/critical vulnerabilities; no new Node dependencies added)
