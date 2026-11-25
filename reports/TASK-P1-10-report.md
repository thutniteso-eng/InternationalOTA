# TASK P1-10 report

## Implemented

### 1. New Dependencies (all from ALLOWED NEW DEPENDENCIES)
Added in `apps/api/package.json`:
- Runtime:
  - `pino`: `^10.4.0` (resolved `10.4.0`)
  - `pino-http`: `^11.0.0` (resolved `11.0.0`)
  - `@opentelemetry/api`: `^1.10.0` (resolved `1.10.0`)
  - `@opentelemetry/sdk-node`: `^0.301.2` (resolved `0.301.2`)
  - `@opentelemetry/sdk-trace-base`: `^2.12.0` (resolved `2.12.0`)
  - `@opentelemetry/exporter-trace-otlp-http`: `^0.301.2` (resolved `0.301.2`)
  - `@opentelemetry/instrumentation-http`: `^0.301.2` (resolved `0.301.2`)
  - `@opentelemetry/instrumentation-express`: `^0.73.0` (resolved `0.73.0`)
  - `@opentelemetry/instrumentation-nestjs-core`: `^0.72.1` (resolved `0.72.1`)
  - `@opentelemetry/instrumentation-pg`: `^0.78.0` (resolved `0.78.0`)
- Dev:
  - `pino-pretty`: `^13.2.0` (resolved `13.2.0`)

All pass `pnpm licenses:check` (`467` packages verified) and `pnpm audit --prod --audit-level high` (0 high, 0 critical).

### 2. Structured JSON Logging & Mandatory Redaction (`apps/api/src/common/observability/logger.ts`)
- Implemented `createPinoLogger()` producing one JSON object per line with `level` (string), `time` (ISO UTC), `msg`, `service: "api"`, `env`, and automatic `requestId` + `traceId` via Pino `mixin()`.
- `LOG_LEVEL` controls log level (default `info`); `LOG_PRETTY=1` enables `pino-pretty` transport in local dev (`NODE_ENV !== 'production'`).
- Implemented `PinoNestLogger` (`LoggerService`) wired via `NestFactory.create(..., { logger })` and `app.useLogger(...)` so all Nest `Logger` calls route through Pino.
- Configured Pino `redact` paths + request/response serializers that drop request bodies by default and redact `authorization`, `cookie`, `set-cookie`, `x-webhook-signature` headers and `password`, `newPassword`, `token`, `secret`, `rawBody`, `cardNumber`, `cvv` fields to `[REDACTED]`.

### 3. Request ID Propagation (`apps/api/src/common/observability/request-context.ts`, `app.setup.ts`, `problem-details.filter.ts`)
- `resolveRequestId()` accepts incoming `X-Request-Id` only when matching `/^[A-Za-z0-9._-]{8,64}$/`; otherwise generates a UUIDv7 (re-exported from `@internationalota/db`).
- Echoes `X-Request-Id` on every response, propagates via `AsyncLocalStorage`, includes `requestId` on every log line of that request, and emits `requestId` in `application/problem+json` error bodies (including 413 and 5xx).
- Preserved G2 behavior: 5xx responses log stack + `requestId` server-side while returning only generic `detail` + `requestId` to clients.

### 4. Async Correlation (`apps/api/src/modules/messaging/outbox.service.ts`, `inbox.service.ts`)
- `OutboxService.enqueue()` captures `getRequestId()` into `payload._meta.requestId` when enqueued during an HTTP request.
- `OutboxService.relayBatch()` restores `requestId` into `AsyncLocalStorage` while executing the handler and logs `eventId`, `eventType`, `attempt`, and `requestId` on publish/retry/dead-letter.
- `InboxService.relayBatch()` logs `provider`, `providerEventId`, and `attempt` without logging payloads.

### 5. OpenTelemetry Tracing (`apps/api/src/tracing.ts`, `main.ts`)
- `apps/api/src/tracing.ts` is imported first in `apps/api/src/main.ts` before `reflect-metadata` and `AppModule`.
- Initializes `NodeSDK` with `HttpInstrumentation`, `ExpressInstrumentation`, `NestInstrumentation`, and `PgInstrumentation` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (or `forceEnable` in tests); otherwise tracing is a no-op.
- `getActiveTraceId()` injects `traceId` into Pino log lines whenever a span is active.

### 6. ESLint `no-console` Guard (`eslint.config.mjs`)
- Added `'no-console': 'error'` for `apps/api/src/**/*.ts` and `packages/*/src/**/*.ts`, excluding the 3 CLI scripts (`packages/db/src/seed.ts`, `packages/db/src/migrate.ts`, `packages/db/src/grant-role.ts`).

---

## Proof Output (AC8 — Deliberate `console.log` in `apps/api/src`)

Temporarily adding `console.log('deliberate no-console lint guard test');` to `apps/api/src/health.controller.ts` and running `pnpm --filter @internationalota/api run lint`:

```
> @internationalota/api@0.0.1 lint /home/iteso/projects/InternationalOTA/apps/api
> eslint .


/home/iteso/projects/InternationalOTA/apps/api/src/health.controller.ts
  20:5  error  Unexpected console statement  no-console

✖ 1 problem (1 error, 0 warnings)

ELIFECYCLE Command failed with exit code 1.
EXIT_CODE=1
```

---

## Fresh-Clone Verification

Will be populated with real outputs from `/tmp/p1check-p110` immediately after pushing branch `task/P1-10-observability`.

---

## Known limitations

- Prometheus metrics, dashboards, alerting, and log shipping are out of scope per spec (P1-12).

## Deviations from spec (and why)

- None.

## Remaining risks

- None. All acceptance criteria (AC1–AC9) are covered by automated integration tests.
