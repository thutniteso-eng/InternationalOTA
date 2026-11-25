import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

const GENERIC_INTERNAL_ERROR_DETAIL = 'An unexpected internal error occurred';

const STATUS_TITLES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
};

/**
 * Global exception filter that maps HttpExceptions and uncaught errors to
 * RFC 9457 Problem Details for HTTP APIs (application/problem+json).
 *
 * For 5xx responses, internal error details are never exposed to clients;
 * the underlying error is logged server-side in structured JSON format.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ path?: string; url?: string; method?: string }>();
    const response = ctx.getResponse<Response>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = GENERIC_INTERNAL_ERROR_DETAIL;
    let title = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (status < 500) {
        if (typeof res === 'string') {
          detail = res;
        } else if (typeof res === 'object' && res !== null) {
          const resObj = res as Record<string, unknown>;
          if (typeof resObj['detail'] === 'string') {
            detail = resObj['detail'];
          } else if (typeof resObj['message'] === 'string') {
            detail = resObj['message'];
          } else if (Array.isArray(resObj['message'])) {
            detail = resObj['message'].join(', ');
          } else {
            detail = exception.message;
          }

          if (typeof resObj['title'] === 'string') {
            title = resObj['title'];
          }
        } else {
          detail = exception.message;
        }
      }

      title = STATUS_TITLES[status] || title;
    }

    if (status >= 500) {
      detail = GENERIC_INTERNAL_ERROR_DETAIL;
      this.logger.error(
        JSON.stringify({
          level: 'error',
          event: 'http_server_error',
          status,
          method: request.method,
          path: request.url ?? request.path,
          errorName: exception instanceof Error ? exception.name : typeof exception,
          errorMessage: exception instanceof Error ? exception.message : String(exception),
          stack: exception instanceof Error ? exception.stack : undefined,
        }),
      );
    }

    // Ensure 409 Conflict includes Retry-After header if not already set
    if (status === Number(HttpStatus.CONFLICT) && !response.getHeader('Retry-After')) {
      response.setHeader('Retry-After', '1');
    }

    response.status(status);
    response.setHeader('Content-Type', 'application/problem+json');
    response.json({
      type: `https://httpstatuses.com/${status}`,
      title,
      status,
      detail,
    });
  }
}
