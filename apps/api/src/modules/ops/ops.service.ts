import {
  and,
  type DatabaseClient,
  desc,
  eq,
  getTableColumns,
  opsAdminAudit,
  opsReconciliationFindings,
  type OpsReconciliationFindingRow,
  opsReconciliationRuns,
  type OpsReconciliationRunRow,
  sql,
  uuidv7,
} from '@internationalota/db';
import type {
  AdminAuditRecordInput,
  OpsReconciliationWorkerPort,
  ReconciliationFinding,
} from '@internationalota/shared';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import pg from 'pg';
import { getRequestId } from '../../common/observability/request-context.js';
import { DATABASE_POOL, DRIZZLE_DB } from '../../database/database.module.js';
import { BookingService } from '../booking/index.js';
import { LedgerService } from '../finance/index.js';
import { InventoryService } from '../inventory/index.js';
import { OutboxService } from '../messaging/index.js';
import { NotificationsService } from '../notifications/index.js';
import { PaymentsService, RefundService } from '../payments/index.js';
import type {
  AdminAuditPort,
  AdminDashboardDto,
  OpsAuditDbRunner,
  ReconciliationFindingDto,
  ReconciliationFindingGroupDto,
  ReconciliationRunDetailDto,
  ReconciliationRunDto,
  ReconciliationRunListResponse,
} from './ops.types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECONCILIATION_ADVISORY_LOCK_KEY = 72100001;
const RECONCILIATION_CHECK_COUNT = 6;
const DEFAULT_RUN_LIST_LIMIT = 20;
const MAX_RUN_LIST_LIMIT = 100;

function toReconciliationRunDto(row: OpsReconciliationRunRow): ReconciliationRunDto {
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    asOf: row.asOf.toISOString(),
    status: row.status,
    counts: row.counts,
    triggeredBy: row.triggeredBy,
  };
}

function toReconciliationFindingDto(row: OpsReconciliationFindingRow): ReconciliationFindingDto {
  return {
    id: row.id,
    runId: row.runId,
    code: row.code,
    severity: row.severity,
    entityType: row.entityType,
    entityId: row.entityId,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
  };
}

export type RunReconciliationOutcome =
  | { readonly ok: true; readonly detail: ReconciliationRunDetailDto }
  | { readonly ok: false; readonly reason: 'already_running' };

@Injectable()
export class OpsService implements AdminAuditPort, OpsReconciliationWorkerPort {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    @Inject(DATABASE_POOL) private readonly pool: pg.Pool,
    private readonly inventoryService: InventoryService,
    private readonly bookingService: BookingService,
    private readonly paymentsService: PaymentsService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly notificationsService: NotificationsService,
    private readonly refundService: RefundService,
  ) {}

  async recordAudit(tx: OpsAuditDbRunner, input: AdminAuditRecordInput): Promise<void> {
    await tx.insert(opsAdminAudit).values({
      id: uuidv7(),
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason ?? null,
      requestId: input.requestId ?? getRequestId() ?? null,
    });
  }

  async runScheduledReconciliation(): Promise<void> {
    const outcome = await this.executeReconciliation({
      triggeredBy: 'cron',
    });
    if (!outcome.ok) {
      this.logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ops_reconciliation_cron_skipped_already_running',
        }),
      );
    }
  }

  async triggerManualReconciliation(
    adminUserId: string,
    reason?: string,
  ): Promise<ReconciliationRunDetailDto> {
    const outcome = await this.executeReconciliation({
      triggeredBy: `admin:${adminUserId}`,
      actorUserId: adminUserId,
      reason: reason?.trim() || 'manual_run',
    });
    if (!outcome.ok) {
      throw new ConflictException({
        message: 'A reconciliation run is already in progress',
        code: 'already_running',
        errorCode: 'reconciliation_already_running',
        i18nKey: 'ops.reconciliation.alreadyRunning',
      });
    }
    return outcome.detail;
  }

  async executeReconciliation(options: {
    readonly triggeredBy: string;
    readonly actorUserId?: string;
    readonly reason?: string;
    readonly asOf?: Date;
  }): Promise<RunReconciliationOutcome> {
    const lockClient = await this.pool.connect();
    let lockAcquired = false;

    try {
      const lockRes = await lockClient.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [RECONCILIATION_ADVISORY_LOCK_KEY],
      );
      lockAcquired = lockRes.rows[0]?.acquired === true;
      if (!lockAcquired) {
        return { ok: false, reason: 'already_running' };
      }

      const nowRes = await this.db.execute(sql`SELECT now() AS "nowTs"`);
      const dbNowRaw = (nowRes.rows[0] as { nowTs?: unknown } | undefined)?.nowTs;
      const dbNow = dbNowRaw instanceof Date ? dbNowRaw : new Date();
      const asOf = options.asOf ?? dbNow;

      const runId = uuidv7();
      await this.db.insert(opsReconciliationRuns).values({
        id: runId,
        asOf,
        status: 'running',
        counts: {
          errors: 0,
          warnings: 0,
          checks: RECONCILIATION_CHECK_COUNT,
          totalFindings: 0,
        },
        triggeredBy: options.triggeredBy,
      });

      let allFindings: ReconciliationFinding[];
      try {
        const results = await Promise.all([
          this.inventoryService.runReconciliationChecks(asOf),
          this.bookingService.runReconciliationChecks(asOf),
          this.paymentsService.runReconciliationChecks(asOf),
          this.ledgerService.runReconciliationChecks(asOf),
          this.outboxService.runReconciliationChecks(asOf),
          this.notificationsService.runReconciliationChecks(asOf),
        ]);
        allFindings = results.flat();
      } catch (err: unknown) {
        await this.db
          .update(opsReconciliationRuns)
          .set({
            status: 'failed',
            finishedAt: sql`now()`,
          })
          .where(
            and(eq(opsReconciliationRuns.id, runId), eq(opsReconciliationRuns.status, 'running')),
          );

        this.logger.error(
          JSON.stringify({
            level: 'error',
            event: 'ops_reconciliation_failed',
            runId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }

      const errorsCount = allFindings.filter((f) => f.severity === 'error').length;
      const warningsCount = allFindings.filter((f) => f.severity === 'warning').length;
      const finalStatus = errorsCount > 0 ? 'errors' : warningsCount > 0 ? 'warnings' : 'ok';

      const detail = await this.db.transaction(async (tx) => {
        const [updatedRun] = await tx
          .update(opsReconciliationRuns)
          .set({
            status: finalStatus,
            finishedAt: sql`now()`,
            counts: {
              errors: errorsCount,
              warnings: warningsCount,
              checks: RECONCILIATION_CHECK_COUNT,
              totalFindings: allFindings.length,
            },
          })
          .where(
            and(eq(opsReconciliationRuns.id, runId), eq(opsReconciliationRuns.status, 'running')),
          )
          .returning();

        let insertedFindings: OpsReconciliationFindingRow[] = [];
        if (allFindings.length > 0) {
          insertedFindings = await tx
            .insert(opsReconciliationFindings)
            .values(
              allFindings.map((finding) => ({
                id: uuidv7(),
                runId,
                code: finding.code,
                severity: finding.severity,
                entityType: finding.entityType,
                entityId: finding.entityId,
                details: finding.details,
              })),
            )
            .returning();
        }

        if (options.actorUserId) {
          await this.recordAudit(tx, {
            actorUserId: options.actorUserId,
            action: 'reconciliation_run',
            targetType: 'reconciliation_run',
            targetId: runId,
            reason: options.reason ?? 'manual_run',
            requestId: getRequestId() ?? null,
          });
        }

        if (errorsCount > 0) {
          await this.outboxService.enqueue(tx, {
            aggregateType: 'reconciliation_run',
            aggregateId: runId,
            eventType: 'ops.reconciliation_errors',
            payload: {
              runId,
              asOf: asOf.toISOString(),
              errors: errorsCount,
              warnings: warningsCount,
              triggeredBy: options.triggeredBy,
            },
          });
        }

        const findingDtos = insertedFindings.map(toReconciliationFindingDto);
        return {
          run: toReconciliationRunDto(updatedRun!),
          findings: findingDtos,
          groupedFindings: this.groupFindingsByCode(findingDtos),
        };
      });

      if (errorsCount > 0) {
        this.logger.error(
          JSON.stringify({
            level: 'error',
            event: 'ops_reconciliation_errors_detected',
            runId,
            errors: errorsCount,
            warnings: warningsCount,
          }),
        );
      } else {
        this.logger.log(
          JSON.stringify({
            level: 'info',
            event: 'ops_reconciliation_completed',
            runId,
            status: finalStatus,
            errors: errorsCount,
            warnings: warningsCount,
          }),
        );
      }

      return { ok: true, detail };
    } finally {
      if (lockAcquired) {
        await lockClient
          .query('SELECT pg_advisory_unlock($1)', [RECONCILIATION_ADVISORY_LOCK_KEY])
          .catch(() => undefined);
      }
      lockClient.release();
    }
  }

  private groupFindingsByCode(
    findings: readonly ReconciliationFindingDto[],
  ): readonly ReconciliationFindingGroupDto[] {
    const groups = new Map<string, ReconciliationFindingDto[]>();
    for (const f of findings) {
      const existing = groups.get(f.code) ?? [];
      existing.push(f);
      groups.set(f.code, existing);
    }
    return Array.from(groups.entries()).map(([code, items]) => ({
      code,
      severity: items[0]!.severity,
      count: items.length,
      items,
    }));
  }

  async listReconciliationRuns(
    query: {
      readonly cursor?: string;
      readonly limit?: string;
    } = {},
  ): Promise<ReconciliationRunListResponse> {
    let limit = DEFAULT_RUN_LIST_LIMIT;
    if (query.limit !== undefined && query.limit !== '') {
      const parsed = Number(query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RUN_LIST_LIMIT) {
        throw new BadRequestException({
          message: `limit must be between 1 and ${MAX_RUN_LIST_LIMIT}`,
          errorCode: 'ops_invalid_query',
        });
      }
      limit = parsed;
    }

    const conditions = [];
    if (query.cursor) {
      let decoded: { startedAt: string; id: string };
      try {
        const raw = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Record<
          string,
          unknown
        >;
        if (
          typeof raw['startedAt'] !== 'string' ||
          typeof raw['id'] !== 'string' ||
          !UUID_REGEX.test(raw['id'])
        ) {
          throw new Error('invalid');
        }
        decoded = { startedAt: raw['startedAt'], id: raw['id'] };
      } catch {
        throw new BadRequestException({
          message: 'Invalid reconciliation pagination cursor',
          errorCode: 'ops_invalid_query',
        });
      }
      conditions.push(
        sql`(${opsReconciliationRuns.startedAt}, ${opsReconciliationRuns.id}) < (${decoded.startedAt}::timestamptz, ${decoded.id}::uuid)`,
      );
    }

    const rows = await this.db
      .select({
        ...getTableColumns(opsReconciliationRuns),
        startedAtCursor: sql<string>`to_char(${opsReconciliationRuns.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(opsReconciliationRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(opsReconciliationRuns.startedAt), desc(opsReconciliationRuns.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(
            JSON.stringify({ startedAt: lastRow.startedAtCursor, id: lastRow.id }),
            'utf8',
          ).toString('base64url')
        : null;

    return {
      items: pageRows.map((row) => toReconciliationRunDto(row)),
      nextCursor,
    };
  }

  async getReconciliationRunDetail(runId: string): Promise<ReconciliationRunDetailDto> {
    if (!UUID_REGEX.test(runId)) {
      throw new NotFoundException({
        message: 'Reconciliation run not found',
        errorCode: 'reconciliation_run_not_found',
      });
    }

    const [run] = await this.db
      .select()
      .from(opsReconciliationRuns)
      .where(eq(opsReconciliationRuns.id, runId))
      .limit(1);

    if (!run) {
      throw new NotFoundException({
        message: 'Reconciliation run not found',
        errorCode: 'reconciliation_run_not_found',
      });
    }

    const findingRows = await this.db
      .select()
      .from(opsReconciliationFindings)
      .where(eq(opsReconciliationFindings.runId, run.id))
      .orderBy(opsReconciliationFindings.severity, opsReconciliationFindings.code);

    const findingDtos = findingRows.map(toReconciliationFindingDto);
    return {
      run: toReconciliationRunDto(run),
      findings: findingDtos,
      groupedFindings: this.groupFindingsByCode(findingDtos),
    };
  }

  async getDashboard(): Promise<AdminDashboardDto> {
    const metrics = await this.bookingService.getAdminDashboardMetrics();
    const [latestRun] = await this.db
      .select()
      .from(opsReconciliationRuns)
      .orderBy(desc(opsReconciliationRuns.startedAt), desc(opsReconciliationRuns.id))
      .limit(1);

    const pendingRefunds = await this.refundService.listAdminRefunds({
      status: 'manual_review,failed',
      limit: '100',
    });

    return {
      today: metrics.today,
      last7Days: metrics.last7Days,
      latestReconciliation: latestRun ? toReconciliationRunDto(latestRun) : null,
      pendingRefundsCount: pendingRefunds.items.length,
    };
  }
}
