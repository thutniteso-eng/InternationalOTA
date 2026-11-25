import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getActiveTraceId } from '../../tracing.js';
import { getRequestId } from './request-context.js';

const MAX_REDACT_DEPTH = 10;
const MAX_COLLECTION_ITEMS = 100;

export const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-webhook-signature',
  'password',
  'newpassword',
  'token',
  'secret',
  'rawbody',
  'cardnumber',
  'cvv',
]);

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-webhook-signature']);

export interface SafeDatabaseCause {
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  routine?: string;
}

export interface SafeSerializedError {
  type: string;
  message: string;
  query?: string;
  stack?: string;
  cause?: SafeDatabaseCause | SafeSerializedError;
}

function isDatabaseQueryError(err: unknown): err is Error & {
  query?: unknown;
  params?: unknown;
  cause?: unknown;
} {
  if (!(err instanceof Error)) {
    return false;
  }
  const rec = err as Error & { query?: unknown; params?: unknown };
  return (
    err.name === 'DrizzleQueryError' || Array.isArray(rec.params) || typeof rec.query === 'string'
  );
}

function extractSafePgCause(cause: unknown): SafeDatabaseCause | undefined {
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  const c = cause as Record<string, unknown>;
  const safe: SafeDatabaseCause = {};
  if (typeof c['code'] === 'string') safe.code = c['code'];
  if (typeof c['constraint'] === 'string') safe.constraint = c['constraint'];
  if (typeof c['table'] === 'string') safe.table = c['table'];
  if (typeof c['column'] === 'string') safe.column = c['column'];
  if (typeof c['routine'] === 'string') safe.routine = c['routine'];
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function stripStackHeader(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined;
  }
  const frames = stack
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
  return frames.length > 0 ? frames : undefined;
}

function isAlreadySerializedError(err: unknown): err is SafeSerializedError {
  if (typeof err !== 'object' || err === null || err instanceof Error || Array.isArray(err)) {
    return false;
  }
  const rec = err as Record<string, unknown>;
  return typeof rec['type'] === 'string' && typeof rec['message'] === 'string';
}

/**
 * Serializes errors safely for structured logging (O1, O4).
 *
 * Order of operations (O4): serialize Error instances FIRST (preserving `type`,
 * `message`, `stack`, and safe `cause` fields, while stripping bound params for
 * query errors), THEN redact the resulting plain object via `redactDeep`.
 * Idempotent on already-serialized error objects so running in both `formatters.log`
 * and Pino's `serializers.err` never collapses an error to `[object Object]`.
 *
 * For `DrizzleQueryError` (and any error carrying a `params` array or `query` string),
 * strips bound parameters from both `message` and `stack`, logs the SQL text without
 * params, and extracts only safe PostgreSQL `cause` fields (`code`, `constraint`,
 * `table`, `column`, `routine`) — explicitly excluding `detail` which can contain PII.
 */
export function serializeSafeError(err: unknown): SafeSerializedError {
  if (isAlreadySerializedError(err)) {
    return redactDeep(err) as SafeSerializedError;
  }

  if (isDatabaseQueryError(err)) {
    const queryText =
      typeof err.query === 'string'
        ? err.query
        : err.message
            .replace(/^Failed query:\s*/i, '')
            .split('\nparams:')[0]
            ?.trim();
    const safeCause = extractSafePgCause(err.cause);
    const safeFrames = stripStackHeader(err.stack);
    const serialized: SafeSerializedError = {
      type: err.name || 'DatabaseQueryError',
      message: 'Database query failed',
      ...(queryText ? { query: queryText } : {}),
      ...(safeCause ? { cause: safeCause } : {}),
      ...(safeFrames ? { stack: safeFrames } : {}),
    };
    return redactDeep(serialized) as SafeSerializedError;
  }

  if (err instanceof Error) {
    const withCause = err as Error & { cause?: unknown };
    const safePgCause = extractSafePgCause(withCause.cause);
    const safeCause = safePgCause
      ? safePgCause
      : withCause.cause instanceof Error
        ? serializeSafeError(withCause.cause)
        : undefined;
    const serialized: SafeSerializedError = {
      type: err.name || 'Error',
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(safeCause ? { cause: safeCause } : {}),
    };
    return redactDeep(serialized) as SafeSerializedError;
  }

  return {
    type: typeof err,
    message: String(err),
  };
}

/**
 * Recursively redacts sensitive keys at ANY nesting depth (including inside arrays),
 * with depth, collection-size, and circular-reference guards (O2).
 */
export function redactDeep(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    return serializeSafeError(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer:${value.length}]`;
  }

  if (depth >= MAX_REDACT_DEPTH) {
    return '[MaxDepth]';
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_COLLECTION_ITEMS);
    const result: unknown[] = [];
    for (let i = 0; i < limit; i++) {
      result.push(redactDeep(value[i], depth + 1, seen));
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
      result.push(`[Truncated:${value.length - MAX_COLLECTION_ITEMS}]`);
    }
    return result;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const limit = Math.min(entries.length, MAX_COLLECTION_ITEMS);
  for (let i = 0; i < limit; i++) {
    const [key, val] = entries[i]!;
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactDeep(val, depth + 1, seen);
    }
  }
  if (entries.length > MAX_COLLECTION_ITEMS) {
    out['_truncatedKeys'] = entries.length - MAX_COLLECTION_ITEMS;
  }
  return out;
}

function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string | string[] | undefined> {
  if (!headers) {
    return {};
  }
  const clean: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    clean[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return clean;
}

export const PINO_SERIALIZERS = {
  // Drop request bodies by default and sanitize sensitive headers
  req: (req: IncomingMessage & { id?: string; requestId?: string }) => ({
    id: req.requestId ?? req.id,
    method: req.method,
    url: req.url,
    headers: sanitizeHeaders(req.headers),
  }),
  res: (res: ServerResponse) => ({
    statusCode: res.statusCode,
  }),
  err: serializeSafeError,
};

export interface CreatePinoLoggerOptions {
  destination?: DestinationStream;
  level?: string;
}

/**
 * Creates a structured JSON Pino logger with recursive deep redaction,
 * safe DB error serialization, ISO UTC timestamps, `service: 'api'`, `env`,
 * and automatic `requestId` + `traceId` injection.
 *
 * `pino-pretty` is a devDependency and is NEVER loaded when `NODE_ENV === 'production'`.
 */
export function createPinoLogger(options: CreatePinoLoggerOptions = {}): Logger {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const level = options.level ?? process.env['LOG_LEVEL'] ?? 'info';
  const usePretty =
    !options.destination && process.env['LOG_PRETTY'] === '1' && nodeEnv !== 'production';

  const pinoOptions: LoggerOptions = {
    level,
    base: {
      service: 'api',
      env: nodeEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => redactDeep(obj) as Record<string, unknown>,
    },
    mixin: () => {
      const fields: Record<string, string> = {};
      const requestId = getRequestId();
      if (requestId) {
        fields['requestId'] = requestId;
      }
      const traceId = getActiveTraceId();
      if (traceId) {
        fields['traceId'] = traceId;
      }
      return fields;
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["set-cookie"]',
        'req.headers["x-webhook-signature"]',
        'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
    serializers: PINO_SERIALIZERS,
  };

  if (usePretty) {
    pinoOptions.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    };
  }

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

/**
 * NestJS `LoggerService` adapter that routes all `new Logger(...)` calls
 * through Pino as structured JSON lines.
 */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly pinoLogger: Logger) {}

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    let context: string | undefined;
    let stack: string | undefined;

    if (optionalParams.length > 0) {
      const last = optionalParams[optionalParams.length - 1];
      if (typeof last === 'string') {
        context = last;
      }
      if (
        level === 'error' &&
        optionalParams.length >= 2 &&
        typeof optionalParams[0] === 'string'
      ) {
        stack = optionalParams[0];
      }
    }

    const baseObj: Record<string, unknown> = {};
    if (context) {
      baseObj['context'] = context;
    }
    if (stack) {
      baseObj['stack'] = stack;
    }

    if (typeof message === 'string') {
      const trimmed = message.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const parsedObj = parsed as Record<string, unknown>;
            const msgText =
              typeof parsedObj['msg'] === 'string'
                ? parsedObj['msg']
                : typeof parsedObj['event'] === 'string'
                  ? parsedObj['event']
                  : 'log';
            this.pinoLogger[level]({ ...baseObj, ...parsedObj }, msgText);
            return;
          }
        } catch {
          // Fall through and log as plain message string
        }
      }
      this.pinoLogger[level](baseObj, message);
      return;
    }

    if (message instanceof Error) {
      this.pinoLogger[level]({ ...baseObj, err: serializeSafeError(message) }, 'error');
      return;
    }

    if (typeof message === 'object' && message !== null) {
      this.pinoLogger[level]({ ...baseObj, ...(message as Record<string, unknown>) }, 'log');
      return;
    }

    this.pinoLogger[level](baseObj, String(message));
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }
}
