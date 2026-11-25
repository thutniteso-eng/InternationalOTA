import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getActiveTraceId } from '../../tracing.js';
import { getRequestId } from './request-context.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-webhook-signature"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["x-webhook-signature"]',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.secret',
  '*.rawBody',
  '*.cardNumber',
  '*.cvv',
  'password',
  'newPassword',
  'token',
  'secret',
  'rawBody',
  'cardNumber',
  'cvv',
];

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-webhook-signature']);

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

export interface CreatePinoLoggerOptions {
  destination?: DestinationStream;
  level?: string;
}

/**
 * Creates a structured JSON Pino logger with mandatory redaction,
 * ISO UTC timestamps, `service: 'api'`, `env`, and automatic
 * `requestId` + `traceId` injection via AsyncLocalStorage / OTel context.
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
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    serializers: {
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
      err: pino.stdSerializers.err,
    },
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
      this.pinoLogger[level]({ ...baseObj, err: message }, message.message);
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
