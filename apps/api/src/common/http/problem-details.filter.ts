import { getDefaultLocale, t } from '@internationalota/i18n';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  LedgerAccountInactiveError,
  LedgerAccountNotFoundError,
  LedgerAlreadyReversedError,
  LedgerConflictError,
  LedgerCurrencyMismatchError,
  LedgerError,
  LedgerUnbalancedError,
  LedgerValidationError,
} from '../../modules/finance/index.js';
import { serializeSafeError } from '../observability/logger.js';
import { getRequestId, getRequestLocale } from '../observability/request-context.js';

const KNOWN_STATUS_TITLE_KEYS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'http.400.title',
  [HttpStatus.UNAUTHORIZED]: 'http.401.title',
  [HttpStatus.FORBIDDEN]: 'http.403.title',
  [HttpStatus.NOT_FOUND]: 'http.404.title',
  [HttpStatus.CONFLICT]: 'http.409.title',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'http.413.title',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'http.422.title',
  [HttpStatus.TOO_MANY_REQUESTS]: 'http.429.title',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'http.500.title',
  [HttpStatus.BAD_GATEWAY]: 'http.502.title',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'http.503.title',
  [HttpStatus.GATEWAY_TIMEOUT]: 'http.504.title',
};

const KNOWN_STATUS_DETAIL_KEYS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'http.400.detail',
  [HttpStatus.UNAUTHORIZED]: 'http.401.detail',
  [HttpStatus.FORBIDDEN]: 'http.403.detail',
  [HttpStatus.NOT_FOUND]: 'http.404.detail',
  [HttpStatus.CONFLICT]: 'http.409.detail',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'http.422.detail',
  [HttpStatus.TOO_MANY_REQUESTS]: 'http.429.detail',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'http.500.detail',
};

interface OwnedMessageMapping {
  readonly key: string;
  readonly params?: Record<string, string | number>;
}

/**
 * Maps known platform-owned English exception messages to catalog keys so
 * `ProblemDetailsFilter` localizes `detail` cleanly without changing domain throw sites.
 */
function matchOwnedHttpErrorMessage(status: number, rawDetail: string): OwnedMessageMapping | null {
  if (status === Number(HttpStatus.BAD_REQUEST) && rawDetail.startsWith('Idempotency-Key header')) {
    return { key: 'http.400.invalidIdempotencyKey' };
  }
  if (status === Number(HttpStatus.UNAUTHORIZED)) {
    if (rawDetail === 'Authentication required') {
      return { key: 'http.401.authRequired' };
    }
    if (rawDetail === 'Missing webhook signature') {
      return { key: 'http.401.missingWebhookSignature' };
    }
    if (
      rawDetail === 'Invalid webhook signature' ||
      rawDetail === 'Invalid webhook signature format' ||
      rawDetail === 'Webhook verification secret is not configured'
    ) {
      return { key: 'http.401.invalidWebhookSignature' };
    }
    if (
      rawDetail === 'Invalid webhook JSON payload' ||
      rawDetail === 'Webhook payload must be a JSON object' ||
      rawDetail.startsWith('Signed webhook body must contain')
    ) {
      return { key: 'http.401.invalidWebhookPayload' };
    }
  }
  if (status === Number(HttpStatus.FORBIDDEN)) {
    if (rawDetail === 'Insufficient role permissions') {
      return { key: 'http.403.insufficientRole' };
    }
    if (rawDetail === 'Cannot access another user resource') {
      return { key: 'http.403.crossAccountForbidden' };
    }
  }
  if (status === Number(HttpStatus.NOT_FOUND)) {
    const providerMatch = /^Unknown webhook provider:\s*(.+)$/.exec(rawDetail);
    if (providerMatch?.[1]) {
      return {
        key: 'http.404.unknownWebhookProvider',
        params: { provider: providerMatch[1] },
      };
    }
  }
  if (
    status === Number(HttpStatus.CONFLICT) &&
    rawDetail === 'A request with this idempotency key is currently in progress'
  ) {
    return { key: 'http.409.idempotencyInProgress' };
  }
  if (
    status === Number(HttpStatus.UNPROCESSABLE_ENTITY) &&
    rawDetail === 'Idempotency key was previously used with a different request payload'
  ) {
    return { key: 'http.422.idempotencyKeyReuse' };
  }
  return null;
}

function mapLedgerError(
  err: LedgerError,
  locale: string,
): { status: number; title: string; detail: string } {
  if (err instanceof LedgerConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      title: t(locale, 'http.409.title'),
      detail: t(locale, 'http.409.ledgerConflict'),
    };
  }
  if (err instanceof LedgerAlreadyReversedError) {
    return {
      status: HttpStatus.CONFLICT,
      title: t(locale, 'http.409.title'),
      detail: t(locale, 'http.409.ledgerAlreadyReversed'),
    };
  }
  if (err instanceof LedgerUnbalancedError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: t(locale, 'http.422.title'),
      detail: t(locale, 'http.422.ledgerUnbalanced', { currency: err.currency }),
    };
  }
  if (err instanceof LedgerAccountNotFoundError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: t(locale, 'http.422.title'),
      detail: t(locale, 'http.422.ledgerAccountNotFound'),
    };
  }
  if (err instanceof LedgerAccountInactiveError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: t(locale, 'http.422.title'),
      detail: t(locale, 'http.422.ledgerAccountInactive'),
    };
  }
  if (err instanceof LedgerCurrencyMismatchError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: t(locale, 'http.422.title'),
      detail: t(locale, 'http.422.ledgerCurrencyMismatch', {
        accountCurrency: err.accountCurrency,
        lineCurrency: err.lineCurrency,
      }),
    };
  }
  if (err instanceof LedgerValidationError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: t(locale, 'http.422.title'),
      detail: t(locale, 'http.422.ledgerValidation'),
    };
  }
  return {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: t(locale, 'http.422.title'),
    detail: t(locale, 'http.422.detail'),
  };
}

/**
 * Global exception filter that maps HttpExceptions, domain LedgerErrors, and uncaught
 * errors to RFC 9457 Problem Details (`application/problem+json`).
 *
 * - Localizes `title` and `detail` according to the resolved request locale (`Content-Language`).
 * - Keeps `type`, `status`, and machine-readable fields language-independent.
 * - Keeps server-side structured error logs in English (never localized).
 * - For 5xx responses, internal error details are never exposed to clients.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{
      path?: string;
      url?: string;
      method?: string;
      requestId?: string;
      locale?: string;
    }>();
    const response = ctx.getResponse<Response>();
    const requestId = request.requestId ?? getRequestId();
    const locale = request.locale ?? getRequestLocale() ?? getDefaultLocale();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = t(locale, 'http.500.detail');
    let title = t(locale, 'http.500.title');

    if (exception instanceof LedgerError) {
      const mapped = mapLedgerError(exception, locale);
      status = mapped.status;
      title = mapped.title;
      detail = mapped.detail;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (status < 500) {
        let rawDetail = exception.message;
        let explicitKey: string | undefined;
        let explicitParams:
          Record<string, string | number | boolean | Date | null | undefined> | undefined;

        if (typeof res === 'string') {
          rawDetail = res;
        } else if (typeof res === 'object' && res !== null) {
          const resObj = res as Record<string, unknown>;
          if (typeof resObj['i18nKey'] === 'string') {
            explicitKey = resObj['i18nKey'];
            if (typeof resObj['i18nParams'] === 'object' && resObj['i18nParams'] !== null) {
              explicitParams = resObj['i18nParams'] as Record<
                string,
                string | number | boolean | Date | null | undefined
              >;
            }
          }
          if (typeof resObj['detail'] === 'string') {
            rawDetail = resObj['detail'];
          } else if (typeof resObj['message'] === 'string') {
            rawDetail = resObj['message'];
          } else if (Array.isArray(resObj['message'])) {
            rawDetail = resObj['message'].join(', ');
          }

          if (typeof resObj['title'] === 'string') {
            title = resObj['title'];
          }
        }

        if (explicitKey) {
          detail = t(locale, explicitKey, explicitParams);
        } else {
          const owned = matchOwnedHttpErrorMessage(status, rawDetail);
          if (owned) {
            detail = t(locale, owned.key, owned.params);
          } else if (
            !rawDetail ||
            rawDetail === exception.name ||
            rawDetail === 'Unauthorized' ||
            rawDetail === 'Forbidden' ||
            rawDetail === 'Not Found' ||
            rawDetail === 'Bad Request' ||
            rawDetail === 'Conflict' ||
            rawDetail === 'Unprocessable Entity' ||
            rawDetail === 'Too Many Requests'
          ) {
            const defaultDetailKey = KNOWN_STATUS_DETAIL_KEYS[status];
            detail = defaultDetailKey ? t(locale, defaultDetailKey) : rawDetail;
          } else {
            detail = rawDetail;
          }
        }
      }

      const titleKey = KNOWN_STATUS_TITLE_KEYS[status];
      if (titleKey) {
        title = t(locale, titleKey);
      }
    }

    if (status >= 500) {
      detail = t(locale, 'http.500.detail');
      const titleKey = KNOWN_STATUS_TITLE_KEYS[status] ?? 'http.500.title';
      title = t(locale, titleKey);

      // Server-side logs always remain in English (not localized)
      const safeErr = serializeSafeError(exception);
      this.logger.error(
        JSON.stringify({
          level: 'error',
          event: 'http_server_error',
          requestId,
          status,
          method: request.method,
          path: request.url ?? request.path,
          errorName: safeErr.type,
          errorMessage: safeErr.message,
          ...(safeErr.query ? { query: safeErr.query } : {}),
          ...(safeErr.cause ? { cause: safeErr.cause } : {}),
          ...(safeErr.stack ? { stack: safeErr.stack } : {}),
        }),
      );
    }

    // Ensure 409 Conflict includes Retry-After header if not already set
    if (status === Number(HttpStatus.CONFLICT) && !response.getHeader('Retry-After')) {
      response.setHeader('Retry-After', '1');
    }

    response.status(status);
    response.setHeader('Content-Type', 'application/problem+json');
    response.setHeader('Content-Language', locale);
    response.json({
      type: `https://httpstatuses.com/${status}`,
      title,
      status,
      detail,
      ...(requestId ? { requestId } : {}),
    });
  }
}
