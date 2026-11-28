import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from '../columns.ts';

export const opsSchema = pgSchema('ops');

export const RECONCILIATION_RUN_STATUSES = [
  'running',
  'ok',
  'warnings',
  'errors',
  'failed',
] as const;
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

export const RECONCILIATION_FINDING_SEVERITIES = ['error', 'warning'] as const;
export type ReconciliationFindingSeverity = (typeof RECONCILIATION_FINDING_SEVERITIES)[number];

export interface ReconciliationRunCountsJson {
  readonly errors: number;
  readonly warnings: number;
  readonly checks: number;
  readonly totalFindings: number;
}

export const opsReconciliationRuns = opsSchema.table(
  'reconciliation_runs',
  {
    id: id('id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('running'),
    counts: jsonb('counts')
      .$type<ReconciliationRunCountsJson>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    triggeredBy: text('triggered_by').notNull(),
  },
  (table) => [
    check(
      'reconciliation_runs_status_check',
      sql`status IN ('running', 'ok', 'warnings', 'errors', 'failed')`,
    ),
    check(
      'reconciliation_runs_finished_consistency_check',
      sql`(status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL)`,
    ),
    index('reconciliation_runs_started_idx').on(table.startedAt, table.id),
  ],
);

export const opsReconciliationFindings = opsSchema.table(
  'reconciliation_findings',
  {
    id: id('id'),
    runId: uuid('run_id')
      .notNull()
      .references(() => opsReconciliationRuns.id),
    code: text('code').notNull(),
    severity: text('severity').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('reconciliation_findings_severity_check', sql`severity IN ('error', 'warning')`),
    index('reconciliation_findings_run_idx').on(table.runId, table.severity, table.code),
  ],
);

export const opsAdminAudit = opsSchema.table(
  'admin_audit',
  {
    id: id('id'),
    actorUserId: text('actor_user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    requestId: text('request_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('admin_audit_at_idx').on(table.at, table.id),
    index('admin_audit_target_idx').on(table.targetType, table.targetId, table.at),
  ],
);

export type OpsReconciliationRunRow = typeof opsReconciliationRuns.$inferSelect;
export type NewOpsReconciliationRunRow = typeof opsReconciliationRuns.$inferInsert;
export type OpsReconciliationFindingRow = typeof opsReconciliationFindings.$inferSelect;
export type NewOpsReconciliationFindingRow = typeof opsReconciliationFindings.$inferInsert;
export type OpsAdminAuditRow = typeof opsAdminAudit.$inferSelect;
export type NewOpsAdminAuditRow = typeof opsAdminAudit.$inferInsert;
