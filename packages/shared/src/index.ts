export interface PlatformInfo {
  readonly name: string;
  readonly tagline: string;
}

export function formatPlatformGreeting(info: PlatformInfo): string {
  return `${info.name} — ${info.tagline}`;
}

export const APP_ENVS = ['local', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

function readEnvVar(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/**
 * Resolves the explicit runtime application environment (`APP_ENV`),
 * independent of `NODE_ENV` (both `staging` and `production` run with `NODE_ENV=production`).
 *
 * Falls back cleanly when `APP_ENV` is unset:
 * - `NODE_ENV=test` -> `'test'`
 * - `NODE_ENV=production` -> `'production'`
 * - otherwise -> `'local'`
 */
export function resolveAppEnv(
  appEnv = readEnvVar('APP_ENV'),
  nodeEnv = readEnvVar('NODE_ENV'),
): AppEnv {
  const normalized = appEnv?.trim().toLowerCase();
  if (normalized) {
    if ((APP_ENVS as readonly string[]).includes(normalized)) {
      return normalized as AppEnv;
    }
    throw new Error(`Invalid APP_ENV "${appEnv}". Expected one of: ${APP_ENVS.join(', ')}.`);
  }

  if (nodeEnv === 'test') {
    return 'test';
  }
  if (nodeEnv === 'production') {
    return 'production';
  }
  return 'local';
}

export type ReconciliationSeverity = 'error' | 'warning';

export interface ReconciliationFinding {
  readonly code: string;
  readonly severity: ReconciliationSeverity;
  readonly entityType: string;
  readonly entityId: string;
  readonly details: Record<string, unknown>;
}

export type AdminAuditAction =
  | 'refund_retry'
  | 'departure_close'
  | 'departure_reopen'
  | 'departure_cancel'
  | 'booking_reject'
  | 'reconciliation_run'
  | 'admin_role_grant';

export interface AdminAuditRecordInput {
  readonly actorUserId: string;
  readonly action: AdminAuditAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason?: string | null;
  readonly requestId?: string | null;
}

export const ADMIN_AUDIT_PORT = 'ADMIN_AUDIT_PORT';
export const BOOKING_SEAT_SUMS_PORT = 'BOOKING_SEAT_SUMS_PORT';
export const LEDGER_BOOKING_EXPECTATION_PORT = 'LEDGER_BOOKING_EXPECTATION_PORT';
export const LEDGER_PAYMENT_EXPECTATION_PORT = 'LEDGER_PAYMENT_EXPECTATION_PORT';
export const BOOKING_ADMIN_PAYMENT_PORT = 'BOOKING_ADMIN_PAYMENT_PORT';
export const BOOKING_ADMIN_NOTIFICATION_PORT = 'BOOKING_ADMIN_NOTIFICATION_PORT';
export const OPS_RECONCILIATION_WORKER_PORT = 'OPS_RECONCILIATION_WORKER_PORT';

export interface OpsReconciliationWorkerPort {
  runScheduledReconciliation(): Promise<void>;
}
