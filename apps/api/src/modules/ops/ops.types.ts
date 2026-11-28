import type { DatabaseTransaction, ReconciliationRunCountsJson } from '@internationalota/db';
import type { AdminAuditRecordInput } from '@internationalota/shared';
import type { AdminBookingDashboardWindowStats } from '../booking/index.js';

export type OpsAuditDbRunner = Pick<DatabaseTransaction, 'insert'>;

export interface AdminAuditPort {
  recordAudit(tx: OpsAuditDbRunner, input: AdminAuditRecordInput): Promise<void>;
}

export interface ReconciliationRunDto {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly asOf: string;
  readonly status: string;
  readonly counts: ReconciliationRunCountsJson;
  readonly triggeredBy: string;
}

export interface ReconciliationFindingDto {
  readonly id: string;
  readonly runId: string;
  readonly code: string;
  readonly severity: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly details: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ReconciliationFindingGroupDto {
  readonly code: string;
  readonly severity: string;
  readonly count: number;
  readonly items: readonly ReconciliationFindingDto[];
}

export interface ReconciliationRunDetailDto {
  readonly run: ReconciliationRunDto;
  readonly findings: readonly ReconciliationFindingDto[];
  readonly groupedFindings: readonly ReconciliationFindingGroupDto[];
}

export interface ReconciliationRunListResponse {
  readonly items: readonly ReconciliationRunDto[];
  readonly nextCursor: string | null;
}

export interface AdminDashboardDto {
  readonly today: AdminBookingDashboardWindowStats;
  readonly last7Days: AdminBookingDashboardWindowStats;
  readonly latestReconciliation: ReconciliationRunDto | null;
  readonly pendingRefundsCount: number;
}

/**
 * Informational ops outbox event types emitted as an alert trail without an
 * in-process outbox consumer yet.
 */
export const OPS_OUTBOX_EVENTS_WITHOUT_CONSUMERS = ['ops.reconciliation_errors'] as const;
