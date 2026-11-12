# TASK P1-07 — Idempotency-Key for mutating API requests

## OBJECTIVE
A client that retries a request (double click, network timeout, mobile reconnect) never causes the action to run twice. This is the first defence against double charges and duplicate bookings.

## BACKGROUND
Read: `docs/ENGINEERING_STANDARDS.md`, `docs/SOLUTION_ARCHITECTURE.md` (booking correctness). Behaviour follows the IETF HTTPAPI "Idempotency-Key" header draft: 400 when a required key is missing, 409 while the first request with that key is still running, 422 when a key is reused with a different payload. P1-06 (identity) is not done yet (waits for D-007), so the key scope is the endpoint for now and gains the caller identity later.

## SCOPE
1. First real API module: `apps/api/src/modules/idempotency/` with public `index.ts` (respect `lint:boundaries`).
2. Table `platform.idempotency_keys` (new migration):
   `scope text`, `key text`, `request_hash char(64)`, `state text CHECK (state IN ('in_progress','completed'))`, `response_status smallint NULL`, `response_body jsonb NULL`, `locked_until timestamptz NOT NULL`, `expires_at timestamptz NOT NULL`, timestamps; **PRIMARY KEY (scope, key)**.
3. Decorator `@Idempotent()` for handlers + a NestJS interceptor implementing the algorithm below. Only decorated handlers are affected.
4. Global exception filter mapping `HttpException` and the idempotency errors to RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`).
5. A test-only controller (registered only when `NODE_ENV=test`) with `POST /__test/idempotent-counter` that increments a counter row — used by the concurrency test.

## ALGORITHM (must be followed exactly)
- Header `Idempotency-Key`: required on `@Idempotent()` handlers; 1–255 chars, printable ASCII without spaces → else **400**.
- `scope` = `METHOD + ' ' + route pattern` (e.g. `POST /bookings`), later prefixed by principal id.
- `request_hash` = SHA-256 hex of `scope + '\n' + canonical JSON body` (object keys sorted recursively; arrays keep order).
- Step 1: `INSERT ... (state='in_progress', locked_until=now()+60s, expires_at=now()+24h) ON CONFLICT (scope,key) DO NOTHING RETURNING *`.
  - Inserted → run handler (Step 3).
  - Not inserted → read the existing row `FOR UPDATE` in a transaction:
    - `expires_at < now()` **or** (`state='in_progress'` and `locked_until < now()`) → take over: reset the row to in_progress with new hash/lock, run handler.
    - `request_hash` differs → **422**.
    - `state='in_progress'` → **409** with `Retry-After: 1`.
    - `state='completed'` → replay stored status + body, header `Idempotent-Replayed: true`, handler NOT executed.
- Step 3 (after handler): status < 500 → store `response_status`, `response_body`, `state='completed'`. Exception/5xx → **delete** the row so the client may retry.
- No business logic inside the interceptor; it must be reusable by every module.

## OUT OF SCOPE
Cleanup job for expired rows (comes with pg-boss in P1-08), auth/principal scoping (P1-06), caching responses with streaming bodies, any business endpoint.

## TECHNICAL INSTRUCTIONS
- No new dependencies (use `node:crypto`).
- All DB access via Drizzle; row lock via `.for('update')` (contention test through Drizzle this time).

## ACCEPTANCE CRITERIA (integration tests against real PostgreSQL)
1. **Concurrency:** 20 parallel requests with the same key and body → counter incremented **exactly once**; every response is either the original 2xx, a replay (`Idempotent-Replayed: true`) or 409.
2. Sequential retry after completion → identical status + body, replay header, counter unchanged.
3. Same key, different body → 422 problem+json.
4. Missing / invalid key → 400 problem+json; non-decorated endpoints unaffected.
5. Handler throws → row deleted → retry with same key executes and succeeds.
6. Expired row and stale in_progress row (simulate by updating timestamps) → taken over and executed.
7. **Mutation evidence in report:** remove the `ON CONFLICT DO NOTHING`/lock logic temporarily → test 1 fails (paste output), then restore.
8. Fresh clone + CI: all checks green.

## DELIVERABLES
Branch `task/P1-07-idempotency`, PR `[P1-07] Idempotency-Key`, report `reports/TASK-P1-07-report.md`.
