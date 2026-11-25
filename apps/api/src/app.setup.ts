import {
  BUILTIN_LOCALES,
  getDefaultLocale,
  matchLocaleTag,
  negotiateLocale,
  setI18nWarnLogger,
  t,
} from '@internationalota/i18n';
import { HttpStatus, type INestApplication } from '@nestjs/common';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import {
  isTrustedProxyIp,
  parseTrustedProxyConfig,
  resolveClientIp,
} from './common/http/client-ip.js';
import { LocaleService } from './common/i18n/locale.service.js';
import {
  createPinoLogger,
  PINO_SERIALIZERS,
  PinoNestLogger,
} from './common/observability/logger.js';
import { resolveRequestId, runWithRequestContext } from './common/observability/request-context.js';
import { IdentityService } from './modules/identity/index.js';

const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1_048_576; // 1 MiB

export interface ConfigureAppOptions {
  logger?: Logger;
}

function getWebhookMaxBodyBytes(): number {
  const raw = process.env['WEBHOOK_MAX_BODY_BYTES'];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEBHOOK_MAX_BODY_BYTES;
}

function sendPayloadTooLarge(
  res: Response,
  maxBytes: number,
  locale: string,
  requestId?: string,
): void {
  if (res.headersSent) {
    return;
  }
  res.status(HttpStatus.PAYLOAD_TOO_LARGE);
  res.setHeader('Content-Type', 'application/problem+json');
  res.setHeader('Content-Language', locale);
  res.json({
    type: `https://httpstatuses.com/${HttpStatus.PAYLOAD_TOO_LARGE}`,
    title: t(locale, 'http.413.title'),
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    detail: t(locale, 'http.413.detail', { maxBytes }),
    ...(requestId ? { requestId } : {}),
  });
}

function resolveFallbackLocale(req: Request): string {
  const rawQuery = Array.isArray(req.query?.['lang']) ? req.query['lang'][0] : req.query?.['lang'];
  if (typeof rawQuery === 'string') {
    const matched = matchLocaleTag(rawQuery, BUILTIN_LOCALES);
    if (matched) {
      return matched;
    }
  }
  return negotiateLocale(req.headers['accept-language'], BUILTIN_LOCALES, getDefaultLocale());
}

/**
 * Configures the NestJS Express application:
 * 0. Wires Pino structured logging, X-Request-Id validation/generation, and AsyncLocalStorage context.
 * 1. Mounts Better Auth on `/api/auth/*` before any body parser consumes the stream.
 * 2. Mounts a size-capped raw-body Buffer collector on `/webhooks/*` so webhook HMAC
 *    signature verification runs against the exact raw bytes before JSON parsing,
 *    and oversized payloads are rejected immediately with 413 problem+json.
 * 3. Re-enables NestJS's built-in JSON and URL-encoded body parsers for all other routes.
 *
 * Callers MUST create the Nest application with `{ bodyParser: false }`.
 */
export function configureApp(app: INestApplication, options: ConfigureAppOptions = {}): void {
  const pinoLogger = options.logger ?? createPinoLogger();
  app.useLogger(new PinoNestLogger(pinoLogger));
  setI18nWarnLogger((msg, meta) => {
    pinoLogger.warn({ event: 'i18n_missing_key', ...meta }, msg);
  });

  const httpAdapter = app.getHttpAdapter();
  const expressApp = httpAdapter.getInstance() as Express;
  const identityService = app.get(IdentityService);
  const trustedProxyConfig = parseTrustedProxyConfig();
  expressApp.set('trust proxy', (ip: string) => isTrustedProxyIp(ip, trustedProxyConfig));

  let localeService: LocaleService | undefined;
  try {
    localeService = app.get(LocaleService, { strict: false });
  } catch {
    localeService = undefined;
  }

  const httpLogger = pinoHttp({
    logger: pinoLogger,
    serializers: PINO_SERIALIZERS,
    genReqId: (req) =>
      (req as Request & { requestId?: string }).requestId ??
      resolveRequestId(req.headers['x-request-id']),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      return 'info';
    },
  });

  // 0. Client IP resolution (L1), Request ID validation/generation, locale resolution, AsyncLocalStorage propagation, and HTTP request logging
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    delete req.headers['x-resolved-client-ip'];
    const clientIp = resolveClientIp(req, trustedProxyConfig);
    if (clientIp) {
      req.headers['x-resolved-client-ip'] = clientIp;
    }

    const requestId = resolveRequestId(req.headers['x-request-id']);
    const locale = localeService
      ? localeService.resolveLocale(req.query?.['lang'], req.headers['accept-language'])
      : resolveFallbackLocale(req);

    (req as Request & { requestId?: string; locale?: string }).requestId = requestId;
    (req as Request & { requestId?: string; locale?: string }).locale = locale;
    if (clientIp) {
      (req as Request & { clientIp?: string }).clientIp = clientIp;
    }
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Content-Language', locale);

    runWithRequestContext(
      requestId,
      () => {
        httpLogger(req, res);
        next();
      },
      locale,
    );
  });

  // 1. Better Auth receives the raw unparsed request stream (Express 5 wildcard syntax)
  expressApp.all('/api/auth/{*splat}', identityService.getAuthHandler());

  // 2. Webhook routes receive exact raw bytes as Buffer, capped at WEBHOOK_MAX_BODY_BYTES (default 1 MiB)
  expressApp.use('/webhooks', (req: Request, res: Response, next: NextFunction) => {
    const maxBytes = getWebhookMaxBodyBytes();
    const requestId = (req as Request & { requestId?: string }).requestId;
    const locale = (req as Request & { locale?: string }).locale ?? getDefaultLocale();
    const contentLengthHeader = req.headers['content-length'];
    if (typeof contentLengthHeader === 'string') {
      const declaredLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        req.pause();
        sendPayloadTooLarge(res, maxBytes, locale, requestId);
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;

    const onData = (chunk: Buffer | string) => {
      if (exceeded) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        req.off('data', onData);
        req.pause();
        sendPayloadTooLarge(res, maxBytes, locale, requestId);
        return;
      }
      chunks.push(buf);
    };

    req.on('data', onData);
    req.on('end', () => {
      if (exceeded) {
        return;
      }
      req.body = Buffer.concat(chunks);
      (req as Request & { _body?: boolean })._body = true;
      next();
    });
    req.on('error', (err) => {
      if (!exceeded) {
        next(err);
      }
    });
  });

  // 3. Re-enable NestJS's built-in body parsers for all remaining routes
  httpAdapter.registerParserMiddleware();
}
