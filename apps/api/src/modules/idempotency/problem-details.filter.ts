import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

const STATUS_TITLES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
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
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ path?: string; url?: string }>();
    const response = ctx.getResponse<Response>();

    // Pass through health probe endpoints so operational readiness checks retain their custom payload
    if (request.path?.startsWith('/health') || request.url?.startsWith('/health')) {
      if (exception instanceof HttpException) {
        response.status(exception.getStatus()).json(exception.getResponse());
        return;
      }
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'An unexpected internal error occurred';
    let title = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

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

      title = STATUS_TITLES[status] || title;
    } else if (exception instanceof Error) {
      detail = exception.message;
    }

    // Ensure 409 Conflict includes Retry-After header if not already set
    if (status === HttpStatus.CONFLICT && !response.getHeader('Retry-After')) {
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
