# TASK P1-12 — Staging environment on the Owner's WSL + Cloudflare quick tunnel (+ carry-overs)

## OBJECTIVE
A production-like copy of the platform runs on the Owner's machine and is reachable over HTTPS from the internet, started and stopped with one command each, with backups that are proven restorable. All open carry-overs from earlier reviews are closed here, because this is the first time the system runs behind a proxy, over HTTPS, with a non-owner database role.

## BACKGROUND
Decision D-017 (Owner, 2026-11-25): staging runs in the Owner's WSL with Docker; public access through a **Cloudflare quick tunnel** (`cloudflared tunnel --url …`, no Cloudflare account, random `*.trycloudflare.com` URL that **changes on every start**, no uptime guarantee — acceptable for an experimental staging). No custom domain yet. Read `docs/CURRENT_STATE.md` (carry-over list) and the reviews of P1-06, P1-09, P1-11.

## SCOPE
### A. Runtime environments
- Introduce `APP_ENV` = `local | test | staging | production` (independent of `NODE_ENV`). Staging and production run with `NODE_ENV=production`.
- `APP_ENV=production` keeps the P1-06 rule "refuse to start without a real EmailSender". `APP_ENV=staging` may use the log-only sender, but must log a WARN at startup.

### B. Deployment files (`deploy/staging/`)
- `compose.yml`: `postgres` (named volume), `migrate` (one-shot, runs migrations + seed as the **owner** role), `api` and `web` (built from the repo with multi-stage Dockerfiles, non-root user, production builds), `caddy` reverse proxy (`/` → web, `/api/*` → api, `/webhooks/*` → api), `cloudflared` (quick tunnel to caddy). Only caddy/cloudflared are reachable from outside the Docker network; postgres is **not** published to the host.
- Basic auth at caddy for everything **except** `/webhooks/*` and `/api/health*` (staging must not be open to the public); credentials from the generated env file.
- `scripts/staging-up.sh`: generates `deploy/staging/.env.staging` on first run (random secrets: DB passwords, `BETTER_AUTH_SECRET`, basic-auth password; file mode 600; git-ignored), starts cloudflared, **reads the assigned `https://…trycloudflare.com` URL from its logs**, writes it as the public base URL, then starts the rest; prints the URL and the basic-auth username. Re-running after a restart picks up the new URL.
- `scripts/staging-down.sh` (stop, keep data) and `scripts/staging-backup.sh` / `staging-restore.sh`.

### C. Carry-overs that must be closed
- **L1 (P1-06)** Real client IP behind cloudflared → caddy → api: trust exactly these proxy hops; derive the client IP from `CF-Connecting-IP` only when the request came through the tunnel/caddy, otherwise from the socket. Rate limiting keys on that IP. A client-supplied `X-Forwarded-For`/`CF-Connecting-IP` sent directly to the api container must not change the key.
- **L2 (P1-06)** Outside `local`/`test`, startup fails without an explicit public base URL and non-empty `AUTH_TRUSTED_ORIGINS`.
- **L3 (P1-06)** Cookie `Secure` flag derived from the public base URL scheme (https → Secure), not from `NODE_ENV`.
- **P1-09** Two DB roles: `ota_owner` (owns schemas, runs migrations/seed) and `ota_app` (used by api: `SELECT/INSERT/UPDATE/DELETE` on the needed tables, `USAGE` on schemas and sequences, **no** ownership, no DDL). pg-boss's schema needs what pg-boss requires — document it. Prove `ota_app` cannot `ALTER TABLE … DISABLE TRIGGER`, `CREATE TABLE`, or `TRUNCATE` ledger tables.
- **I1 (P1-11)** Remove `ISO_EXTRA_CURRENCY_EXPONENTS`; `formatMoney` accepts only supported `Money`; replace KWD tests with JPY/KRW.
- **I2 (P1-11)** Owned errors throw with an explicit `i18nKey`; remove `matchOwnedHttpErrorMessage` string matching.

### D. Backups
- `staging-backup.sh`: `pg_dump --format=custom` of the database into a host folder (default `~/ota-backups/`, outside the repo), timestamped, keeping the last 7.
- `staging-restore.sh <file>`: restores into a **new** database and prints row counts of key tables for comparison; never overwrites the live DB without an explicit `--replace` flag.

## OUT OF SCOPE
Custom domain, Cloudflare account/Access, production hosting, CI deployment, monitoring dashboards, real email provider.

## ACCEPTANCE CRITERIA (Antigravity runs these on the Owner's WSL and pastes real output)
1. From a clean clone: `scripts/staging-up.sh` prints a `https://….trycloudflare.com` URL. Through that URL: without basic auth → 401; with it → `/vi` and `/en` pages render; `/api/health/ready` → 200 (no basic auth needed).
2. Sign-up and sign-in work through the URL; the session cookie is `Secure; HttpOnly; SameSite=Lax`.
3. **L1:** repeated wrong passwords through the tunnel → 429; a request sent directly to the api container with forged `X-Forwarded-For`/`CF-Connecting-IP` values does not reset or change the rate-limit key (test or scripted proof).
4. **L2:** api refuses to start with `APP_ENV=staging` and an empty `AUTH_TRUSTED_ORIGINS` (show error).
5. **P1-09 roles:** as `ota_app`: `ALTER TABLE finance.journal_lines DISABLE TRIGGER ALL` → denied; `CREATE TABLE public.x(i int)` → denied; `TRUNCATE finance.journal_lines` → denied; normal API flows work.
6. Postgres is not reachable from the host or the internet (show `docker compose ps` ports and a failed connection attempt).
7. Backup → restore into a new DB → row counts match for `identity.user`, `reference.currencies`, `finance.journal_entries`.
8. `staging-down.sh` then `staging-up.sh` → new URL, data preserved (previous user can still sign in).
9. I1/I2 closed with tests; fresh clone + CI green (CI does not deploy).
10. Report states the public URL that was live during verification, so Claude can fetch `/api/health/ready` independently.

## ALLOWED NEW DEPENDENCIES
None in the Node workspace. Docker images: `postgis/postgis:17-3.5`, `caddy:2`, `cloudflare/cloudflared` — pin by version tag (not `latest`).

## DELIVERABLES
Branch `task/P1-12-staging`, PR `[P1-12] Staging environment`, report `reports/TASK-P1-12-report.md`, short Owner guide `deploy/staging/README.vi.md` (in Vietnamese: start, stop, back up, restore).
