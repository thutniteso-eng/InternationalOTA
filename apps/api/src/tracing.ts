import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';

const INVALID_TRACE_ID = '00000000000000000000000000000000';

let activeSdk: NodeSDK | null = null;

export interface InitTracingOptions {
  /**
   * Optional custom span exporter (e.g. InMemorySpanExporter in tests).
   * When provided, uses SimpleSpanProcessor for synchronous flush in tests.
   */
  spanExporter?: SpanExporter;
  /**
   * Force initialization even when OTEL_EXPORTER_OTLP_ENDPOINT is unset (tests).
   */
  forceEnable?: boolean;
}

/**
 * Initializes OpenTelemetry NodeSDK with HTTP, Express, NestJS, and pg instrumentations.
 * Must be called BEFORE application modules are imported.
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is not set (and `forceEnable` is false),
 * tracing is a no-op and returns `null`.
 */
export function initTracing(options: InitTracingOptions = {}): NodeSDK | null {
  if (activeSdk) {
    return activeSdk;
  }

  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!endpoint && !options.forceEnable) {
    return null;
  }

  const instrumentations = [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new NestInstrumentation(),
    new PgInstrumentation(),
  ];

  const sdk = options.spanExporter
    ? new NodeSDK({
        serviceName: 'api',
        autoDetectResources: false,
        spanProcessors: [new SimpleSpanProcessor(options.spanExporter)],
        instrumentations,
      })
    : new NodeSDK({
        serviceName: 'api',
        traceExporter: new OTLPTraceExporter(endpoint ? { url: endpoint } : {}),
        instrumentations,
      });

  sdk.start();
  activeSdk = sdk;
  return sdk;
}

export async function shutdownTracing(): Promise<void> {
  if (!activeSdk) {
    return;
  }
  const sdk = activeSdk;
  activeSdk = null;
  await sdk.shutdown();
}

/**
 * Returns the active OpenTelemetry traceId if a valid span is currently active.
 */
export function getActiveTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) {
    return undefined;
  }
  const traceId = span.spanContext().traceId;
  if (!traceId || traceId === INVALID_TRACE_ID) {
    return undefined;
  }
  return traceId;
}

// Auto-initialize when loaded first (e.g. `import './tracing.js'` at top of main.ts)
if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim()) {
  initTracing();
}
