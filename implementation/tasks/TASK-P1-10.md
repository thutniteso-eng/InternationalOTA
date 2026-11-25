# TASK P1-10 — Observability: structured logs, request IDs, tracing

## OBJECTIVE
When something goes wrong in production (a failed payment, a stuck booking), we can follow one request or one event end-to-end across API, database, outbox and jobs — without ever leaking secrets or personal data into logs.

## BACKGROUND
Read: `docs/ENGINEERING_STANDARDS.md`. Existing: `ProblemDetailsFilter` (`common/http`, 5xx details only in server logs), messaging relay/jobs (P1-08), idempotency (P1-07), identity (P1-06). Today logging uses Nest's default `Logger` with free-text messages.

## SCOPE
1. **Structured JSON logs** via `pino` (+ `nestjs-pino` or `pino-http`): one JSON object per line with at least `level`, `time` (ISO UTC), `msg`, `requestId` (when in a request), `service: "api"`, `env`. Pretty output only when `LOG_PRETTY=1` in local dev. Level from `LOG_LEVEL` (default `info`). Nest's `Logger` calls are routed through pino so existing code keeps working.
2. **Request ID:** accept incoming `X-Request-Id` only if it matches `^[A-Za-z0-9._-]{8,64}$`, otherwise generate a UUIDv7. Echo it in the response header and include it in every log line of that request and as `requestId` in problem+json bodies.
3. **Redaction (mandatory):** never log `authorization`, `cookie`, `set-cookie`, `x-webhook-signature` headers, nor body fields named `password`, `newPassword`, `token`, `secret`, `rawBody`, `cardNumber`, `cvv` (pino `redact` paths + a request serializer that drops request bodies by default). Webhook/inbox payloads are never logged at `info`.
4. **Correlation for async work:** outbox relay and job logs carry `eventId`, `eventType`, `attempt`; inbox logs carry `provider`, `providerEventId`. When an event is enqueued inside a request, store the `requestId` in the outbox row's payload metadata (or a new nullable column) and log it when the event is handled.
5. **Tracing (OpenTelemetry):** `@opentelemetry/sdk-node` with HTTP, Express/Nest and `pg` instrumentations; OTLP HTTP exporter enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (otherwise tracing is a no-op). The trace id is added to log lines (`traceId`) when a span is active. Tracing initialises **before** the app modules are imported (separate `tracing.ts` loaded first).
6. **Lint guard:** forbid `console.*` in `apps/api/src` and `packages/*/src` (ESLint `no-console`), except the CLI scripts in `packages/db/src` (seed, migrate, grant-role) which may keep console output.

## ALLOWED NEW DEPENDENCIES
`pino`, `nestjs-pino` or `pino-http`, `pino-pretty` (dev), `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-express`, `@opentelemetry/instrumentation-nestjs-core`, `@opentelemetry/instrumentation-pg`. No `auto-instrumentations-node` meta-package. All must pass `licenses:check` and `pnpm audit --prod --audit-level high`; if not, stop and report.

## OUT OF SCOPE
Metrics/Prometheus endpoint, dashboards, alerting, log shipping infrastructure (P1-12 decides where logs go), frontend logging.

## ACCEPTANCE CRITERIA (tests capture log output in memory)
1. A request produces JSON log lines that all carry the same `requestId`, which equals the response `X-Request-Id` header and the `requestId` in a problem+json error body.
2. Valid incoming `X-Request-Id` is honoured; invalid ones (too long, spaces, `\n` injection) are replaced by a generated id.
3. **Redaction:** a sign-in request with a password and a request with `Authorization`/`Cookie` headers produce logs that contain none of the secret values (assert on the captured raw log text). A signed webhook request never logs the signature or raw body.
4. A 5xx error logs the stack server-side with `requestId`; the response body contains only the generic detail (existing G2 behaviour preserved).
5. An event enqueued during a request is handled by the relay with logs containing the same `requestId` and the `eventId`.
6. With an in-memory span exporter in the test, one HTTP request that queries the DB yields an HTTP server span with a child `pg` span sharing the trace id; log lines in that request carry that `traceId`.
7. Tracing disabled (no endpoint set) → app starts and all existing tests pass unchanged.
8. ESLint fails on a deliberate `console.log` in `apps/api/src` (show output).
9. Fresh clone + CI green.

## DELIVERABLES
Branch `task/P1-10-observability`, PR `[P1-10] Observability`, report `reports/TASK-P1-10-report.md` (list exact dependency versions).
