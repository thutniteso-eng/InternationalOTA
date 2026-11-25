# TASK P1-08 — Transactional outbox, job queue and webhook inbox

## OBJECTIVE
Business events are never lost and never applied twice: an event is written in the **same database transaction** as the business change, then delivered asynchronously, retried on failure, and dead-lettered after repeated failure. Incoming provider webhooks (payment gateway, suppliers) are verified, stored once, and processed once even when the provider sends duplicates.

## BACKGROUND
Decisions: D-006 (DB-persisted saga + job queue), D-012 (pg-boss on PostgreSQL; no Redis for correctness). Read `docs/SOLUTION_ARCHITECTURE.md` (booking correctness), `docs/ENGINEERING_STANDARDS.md`. Body parsing is disabled globally and re-registered after the auth handler (P1-06) — webhook signature checks need the **raw** bytes.

## SCOPE
### A. Tables (schema `platform`, new migration)
- `platform.outbox_events`: `id uuid` (v7) PK, `aggregate_type text`, `aggregate_id text`, `event_type text`, `payload jsonb`, `occurred_at timestamptz default now()`, `published_at timestamptz NULL`, `attempts int default 0`, `last_error text NULL`, `dead_lettered_at timestamptz NULL`. Partial index on unpublished, not-dead-lettered rows.
- `platform.inbox_messages`: `provider text`, `provider_event_id text`, `payload jsonb`, `received_at`, `processed_at NULL`, `attempts`, `last_error NULL`, `dead_lettered_at NULL`; **PRIMARY KEY (provider, provider_event_id)**.

### B. Module `apps/api/src/modules/messaging/` (public `index.ts`)
1. `OutboxService.enqueue(tx, event)` — **requires** the caller's Drizzle transaction handle; there is no overload without one.
2. Relay: claims batches with `SELECT … FOR UPDATE SKIP LOCKED`, dispatches to registered handlers (`registerHandler(eventType, handler)`), marks `published_at`. Handler failure → `attempts+1`, `last_error`, exponential backoff; after `MAX_ATTEMPTS` (config, default 10) → `dead_lettered_at` + structured ERROR log. Delivery is **at-least-once**: document that handlers must be idempotent.
3. pg-boss (dependency `pg-boss`, **exact** version pin, licence must pass CI) runs the relay loop and scheduled jobs. Scheduled job `idempotency-keys-cleanup` (daily) deletes `platform.idempotency_keys` rows with `expires_at < now()` (carried from P1-07 out-of-scope).
4. Graceful shutdown: stop claiming new work, finish in-flight handlers, then close.

### C. Webhook inbox
- `POST /webhooks/:provider` receives the **raw body** (mount a raw-body parser for this route before the global JSON parser).
- `WebhookVerifier` interface per provider (`verify(rawBody, headers) → { eventId, payload }` or throws). Implement only a `test` provider using HMAC-SHA256 with a secret from env (`WEBHOOK_TEST_SECRET`), constant-time comparison.
- Invalid signature / unknown provider → 401/404 problem+json, **nothing stored**.
- Valid → `INSERT … ON CONFLICT (provider, provider_event_id) DO NOTHING`; respond **200 immediately in both cases** (new or duplicate) — providers retry on non-2xx. Processing happens asynchronously via the same relay/retry/dead-letter rules.
- Raw payloads are stored as received; never log full payloads at INFO (they can contain personal data).

## OUT OF SCOPE
Real payment/supplier providers, booking events, admin UI for dead letters (later), Redis.

## ACCEPTANCE CRITERIA (integration tests, isolated temporary database)
1. **Atomicity:** enqueue inside a transaction that rolls back → no outbox row, handler never called; commit → handler called exactly once.
2. **Concurrent relays:** 3 relay workers on 50 events → every event handled **exactly once** (count per id). **Mutation evidence:** remove `SKIP LOCKED`/`FOR UPDATE` → test fails (paste output).
3. **Retry & dead letter:** handler fails twice then succeeds → published, `attempts = 2`; handler always fails → dead-lettered after `MAX_ATTEMPTS`, not retried further.
4. **Crash between handling and marking** (simulate by throwing after the handler ran, before `published_at` is set) → event redelivered; test documents the at-least-once guarantee.
5. **Webhook:** same signed event sent 5 times (also 5 concurrently) → one inbox row, processed once, all responses 200. Tampered body or wrong signature → 401 and no row. Body must be verified on raw bytes (a re-serialised JSON with different whitespace must fail).
6. Cleanup job deletes only expired idempotency rows.
7. Graceful shutdown test: in-flight handler completes; no new claims after shutdown starts.
8. Fresh clone + CI green; `licenses:check` and `pnpm audit --prod --audit-level high` pass.

## DELIVERABLES
Branch `task/P1-08-outbox-inbox`, PR `[P1-08] Outbox, job queue and webhook inbox`, report `reports/TASK-P1-08-report.md` (include pg-boss version and the mutation output).
