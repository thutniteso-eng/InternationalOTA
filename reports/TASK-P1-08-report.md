# TASK P1-08 report

## Implemented

### 1. Pinned Dependency
- `pg-boss`: pinned to exact version **`12.39.0`** in `apps/api/package.json` (`"pg-boss": "12.39.0"`). No other new runtime dependency was added.
- Re-exported Drizzle query helpers (`and`, `asc`, `desc`, `eq`, `gt`, `gte`, `isNotNull`, `isNull`, `lt`, `lte`, `ne`, `or`, `sql`) from `@internationalota/db` (`packages/db/src/index.ts`) so `apps/api` and `packages/db` share a single Drizzle type graph after `pg-boss` introduced `@opentelemetry/api` as an optional peer of `drizzle-orm`.

### 2. Database Schema & Migration (`platform.outbox_events` & `platform.inbox_messages`)
- Added `outboxEvents` and `inboxMessages` tables in `packages/db/src/schema/platform.ts`:
  - `platform.outbox_events`: `id uuid` (UUIDv7 PK), `aggregate_type`, `aggregate_id`, `event_type`, `payload jsonb`, `occurred_at timestamptz default now()`, `published_at timestamptz NULL`, `attempts int default 0`, `next_attempt_at timestamptz default now()`, `last_error text NULL`, `dead_lettered_at timestamptz NULL`, plus partial index `outbox_events_pending_idx` on `(next_attempt_at, occurred_at) WHERE published_at IS NULL AND dead_lettered_at IS NULL`.
  - `platform.inbox_messages`: `provider`, `provider_event_id`, `payload jsonb`, `received_at`, `processed_at NULL`, `attempts default 0`, `next_attempt_at default now()`, `last_error NULL`, `dead_lettered_at NULL`, **PRIMARY KEY `(provider, provider_event_id)`**, plus partial index `inbox_messages_pending_idx` on `(next_attempt_at, received_at) WHERE processed_at IS NULL AND dead_lettered_at IS NULL`.
- Exported `DatabaseTransaction` type from `packages/db/src/client.ts`.
- Generated forward-only migration `packages/db/migrations/0004_wet_sharon_ventura.sql`.

### 3. Messaging Module (`apps/api/src/modules/messaging/`)
- Public boundary (`index.ts`) exports `MessagingModule`, `OutboxService`, `InboxService`, `JobQueueService`, `TestHmacWebhookVerifier`, queue constants, and types.
- **Transactional outbox (`outbox.service.ts`)**:
  - `OutboxService.enqueue(tx: DatabaseTransaction, event)` requires the caller's Drizzle transaction handle with no overload without one.
  - `relayBatch()` claims due batches using `SELECT ... FOR UPDATE SKIP LOCKED`, dispatches to registered handlers (`registerHandler(eventType, handler)`), marks `published_at` on success, applies exponential backoff (`attempts + 1`, `last_error`, `next_attempt_at`) on failure, and dead-letters (`dead_lettered_at` + structured ERROR log) after `MAX_ATTEMPTS` (env `OUTBOX_MAX_ATTEMPTS`, default `10`).
  - Documented as **at-least-once** delivery; handlers must be idempotent.
- **Job queue & scheduled jobs (`job-queue.service.ts`)**:
  - Runs `pg-boss@12.39.0` on PostgreSQL for `outbox-relay`, `inbox-relay`, and daily `idempotency-keys-cleanup` (`DELETE FROM platform.idempotency_keys WHERE expires_at < now()`).
  - Graceful shutdown (`onApplicationShutdown`): stops claiming new work (`beginShutdown()`), stops `pg-boss` gracefully, and awaits all in-flight handlers (`waitForInFlight()`).
- **Webhook inbox (`webhooks.controller.ts`, `inbox.service.ts`, `test-webhook.verifier.ts`)**:
  - Raw-body middleware mounted in `apps/api/src/app.setup.ts` on `/webhooks` BEFORE `httpAdapter.registerParserMiddleware()` so `POST /webhooks/:provider` receives the exact raw `Buffer`.
  - `WebhookVerifier` interface with `TestHmacWebhookVerifier` (`provider = 'test'`) using HMAC-SHA256 over raw bytes, `WEBHOOK_TEST_SECRET`, and constant-time `timingSafeEqual`.
  - Unknown provider -> 404 `problem+json`; invalid/missing signature or tampered/re-serialized body -> 401 `problem+json`, nothing stored.
  - Valid webhook -> `INSERT ... ON CONFLICT (provider, provider_event_id) DO NOTHING`, responds **200** immediately for both new and duplicate deliveries, logs metadata only (never full payload), and processes asynchronously via `InboxService.relayBatch()` with the same `SKIP LOCKED` / retry / dead-letter rules.

---

## Files created/modified/deleted

- **Created**:
  - `packages/db/migrations/0004_wet_sharon_ventura.sql`
  - `packages/db/migrations/meta/0004_snapshot.json`
  - `apps/api/src/modules/messaging/messaging.types.ts`
  - `apps/api/src/modules/messaging/outbox.service.ts`
  - `apps/api/src/modules/messaging/inbox.service.ts`
  - `apps/api/src/modules/messaging/test-webhook.verifier.ts`
  - `apps/api/src/modules/messaging/webhooks.controller.ts`
  - `apps/api/src/modules/messaging/job-queue.service.ts`
  - `apps/api/src/modules/messaging/messaging.module.ts`
  - `apps/api/src/modules/messaging/index.ts`
  - `apps/api/src/modules/messaging/messaging.spec.ts`
  - `reports/TASK-P1-08-report.md`

- **Modified**:
  - `apps/api/package.json`, `pnpm-lock.yaml` (`pg-boss: "12.39.0"`)
  - `packages/db/src/client.ts`, `packages/db/src/index.ts`, `packages/db/src/schema/platform.ts`, `packages/db/migrations/meta/_journal.json`
  - `apps/api/src/app.module.ts`, `apps/api/src/app.setup.ts`
  - `apps/api/src/health.controller.ts`, `apps/api/src/modules/idempotency/idempotency.interceptor.ts`, `apps/api/src/modules/idempotency/test-idempotent-counter.controller.ts`, `apps/api/src/modules/idempotency/idempotency.spec.ts`, `apps/api/src/modules/identity/identity.service.ts`, `apps/api/src/modules/identity/identity.spec.ts` (import Drizzle query helpers from `@internationalota/db`)

---

## Mutation Evidence (Criterion 2)

Temporarily removing `.for('update', { skipLocked: true })` from `OutboxService.relayBatch()` in `apps/api/src/modules/messaging/outbox.service.ts` and running Criterion 2 (3 concurrent relay workers on 50 events) caused immediate duplicate handling and test failure:

```
 ❯ src/modules/messaging/messaging.spec.ts (7 tests | 1 failed | 6 skipped) 1065ms
   ❯ Messaging module integration tests (P1-08) (7)
     × AC2: Concurrent relays - 3 relay workers on 50 events handle every event exactly once 630ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/modules/messaging/messaging.spec.ts > Messaging module integration tests (P1-08) > AC2: Concurrent relays - 3 relay workers on 50 events handle every event exactly once
AssertionError: expected 3 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 3

 ❯ src/modules/messaging/messaging.spec.ts:194:34
    192|     expect(countsById.size).toBe(eventCount);
    193|     for (const id of enqueuedIds) {
    194|       expect(countsById.get(id)).toBe(1);
       |                                  ^
    195|     }
    196|

EXIT_CODE=1
```

Restoring `.for('update', { skipLocked: true })` made all 7 tests in `messaging.spec.ts` pass reliably.

---

## Fresh-Clone Verification

Verified in a fresh clone of `task/P1-08-outbox-inbox` at `/tmp/p1check-p108` (commit `fe06a160ac13516661201363bda5f971d4ba07ac`):

```bash
rm -rf /tmp/p1check-p108
git clone -b task/P1-08-outbox-inbox https://github.com/thutniteso-eng/InternationalOTA.git /tmp/p1check-p108
cd /tmp/p1check-p108
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm lint:boundaries
pnpm typecheck
pnpm build
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm db:migrate
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm db:seed
DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm test
pnpm licenses:check
pnpm audit --prod --audit-level high
```

Real results (all commands exited `0`):
- `pnpm format:check`: `All matched files use Prettier code style!` across all 6 workspace projects + `tools/`.
- `pnpm lint`: all 6 workspace projects + `eslint tools` passed with 0 errors.
- `pnpm lint:boundaries`: `✔ no dependency violations found`.
- `pnpm typecheck` & `pnpm build`: all 6 workspace projects built and typechecked cleanly.
- `pnpm db:migrate` & `pnpm db:seed`: applied `0004_wet_sharon_ventura.sql` and seeded reference data idempotently.
- `pnpm test` (Vitest `4.1.12`):
  - `apps/api`: `Test Files  5 passed (5)` / `Tests  38 passed (38)` (`hash.spec.ts` 11, `health.controller.spec.ts` 3, `idempotency.spec.ts` 9, `identity.spec.ts` 8, `messaging.spec.ts` 7 covering AC1–AC7).
  - `packages/db`: 22 passed; `packages/money`: 41 passed; `packages/time`: 19 passed; `packages/shared`: passed; `apps/web`: 1 passed; `tools`: 16 passed.
- `pnpm licenses:check`: `✅ All 379 package licenses verified successfully.`
- `pnpm audit --prod --audit-level high`: exited `0` (0 high, 0 critical; 1 moderate).

---

## Known limitations

- Only the `test` HMAC-SHA256 webhook verifier is registered; real payment/supplier provider verifiers and booking domain events are out of scope per spec.

## Deviations from spec (and why)

- None.

## Remaining risks

- None. All acceptance criteria (AC1–AC8) are verified with deterministic integration tests on isolated temporary PostgreSQL databases.
