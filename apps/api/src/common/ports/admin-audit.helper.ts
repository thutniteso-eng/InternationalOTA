import { type Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Enforces fail-closed semantics on ADMIN_AUDIT_PORT (SOLUTION_ARCHITECTURE.md).
 * Invoked inside the mutating database transaction so missing audit wiring rolls
 * back any state change and rejects with HTTP 503 + structured error log.
 */
export function requireAdminAuditPort<TPort>(
  port: TPort | null,
  logger: Logger,
  operation: string,
  targetId: string,
): TPort {
  if (!port) {
    logger.error(`Refusing ${operation} on ${targetId}: ADMIN_AUDIT_PORT is unavailable`);
    throw new ServiceUnavailableException({
      message: 'Admin audit service is unavailable; operation refused.',
      i18nKey: 'http.503.title',
      errorCode: 'ops.audit.unavailable',
    });
  }
  return port;
}
