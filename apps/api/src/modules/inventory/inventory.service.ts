import {
  and,
  type AllocationState,
  asc,
  type DatabaseClient,
  type DepartureStatus,
  eq,
  gte,
  inventoryDepartures,
  lte,
  sql,
  uuidv7,
} from '@internationalota/db';
import {
  addDays,
  InvalidDateError,
  InvalidDateRangeError,
  nightsBetween,
  parseLocalDate,
} from '@internationalota/time';
import {
  ADMIN_AUDIT_PORT,
  BOOKING_SEAT_SUMS_PORT,
  type ReconciliationFinding,
} from '@internationalota/shared';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getRequestId } from '../../common/observability/request-context.js';
import { requireAdminAuditPort } from '../../common/ports/admin-audit.helper.js';
import { DRIZZLE_DB } from '../../database/database.module.js';
import type { BookingSeatSumsPort } from '../booking/index.js';
import { catalogProductNotFoundException, CatalogService } from '../catalog/index.js';
import {
  inventoryAllocationAlreadyReleasedException,
  inventoryAllocationQuantityConflictException,
  inventoryCapacityBelowAllocatedException,
  inventoryDepartureAlreadyCancelledException,
  inventoryDepartureNotFoundException,
  inventoryInvalidQueryException,
  inventoryNonExistentLocalTimeException,
  inventoryUnsupportedProductKindException,
} from './inventory.errors.js';
import type {
  AdminAuditTxRunner,
  AdminDepartureDto,
  AdminDepartureListResponse,
  AllocateInput,
  AllocateResult,
  CancelDepartureResult,
  GenerateDeparturesInput,
  GenerateDeparturesResult,
  InventoryDepartureQuoteTarget,
  PublicAvailabilityItem,
  PublicAvailabilityResponse,
  ReleaseInput,
  ReleaseResult,
  UpdateDepartureInput,
} from './inventory.types.js';

export type InventoryDbRunner = Pick<DatabaseClient, 'execute' | 'select' | 'insert' | 'update'>;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MAX_GENERATE_DAYS = 366;
const MAX_PUBLIC_WINDOW_DAYS = 62;
const DEFAULT_CUTOFF_MINUTES = 60;

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function isoWeekday(localDate: string): number {
  const [yStr, mStr, dStr] = localDate.split('-');
  const dt = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)));
  const day = dt.getUTCDay();
  return day === 0 ? 7 : day;
}

function normalizeLocalTime(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw inventoryInvalidQueryException('localTimes entries must be HH:MM strings');
  }
  const trimmed = raw.trim();
  const match = LOCAL_TIME_REGEX.exec(trimmed);
  if (!match) {
    throw inventoryInvalidQueryException(`invalid localTime "${raw}" (expected HH:MM or HH:MM:SS)`);
  }
  const hh = match[1]!;
  const mm = match[2]!;
  const ss = match[3] ?? '00';
  return `${hh}:${mm}:${ss}`;
}

function parseDateWindow(fromRaw: string, toRaw: string, maxInclusiveDays: number) {
  let fromDate: string;
  let toDate: string;
  let nights: number;
  try {
    fromDate = parseLocalDate(fromRaw);
    toDate = parseLocalDate(toRaw);
    nights = nightsBetween(fromDate, toDate);
  } catch (err) {
    if (err instanceof InvalidDateError || err instanceof InvalidDateRangeError) {
      throw inventoryInvalidQueryException(err.message);
    }
    throw err;
  }
  const inclusiveDays = nights + 1;
  if (inclusiveDays > maxInclusiveDays) {
    throw inventoryInvalidQueryException(
      `date window of ${inclusiveDays} days exceeds maximum of ${maxInclusiveDays} days`,
    );
  }
  return { fromDate, toDate };
}

function toAdminDepartureDto(row: typeof inventoryDepartures.$inferSelect): AdminDepartureDto {
  return {
    id: row.id,
    productId: row.productId,
    localDate: row.localDate,
    localTime: row.localTime,
    startsAt: row.startsAt.toISOString(),
    capacity: row.capacity,
    allocated: row.allocated,
    remaining: Math.max(0, row.capacity - row.allocated),
    status: row.status as DepartureStatus,
    bookingCutoffMinutes: row.bookingCutoffMinutes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class InventoryService implements OnModuleInit {
  private readonly logger = new Logger(InventoryService.name);
  private bookingSeatSumsPort: BookingSeatSumsPort | null = null;
  private adminAuditPort: AdminAuditTxRunner | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly catalogService: CatalogService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  onModuleInit(): void {
    if (!this.moduleRef) {
      this.logger.warn(
        'ModuleRef missing during InventoryService initialization; ADMIN_AUDIT_PORT unavailable.',
      );
      return;
    }
    try {
      this.bookingSeatSumsPort = this.moduleRef.get<BookingSeatSumsPort>(BOOKING_SEAT_SUMS_PORT, {
        strict: false,
      });
    } catch {
      this.bookingSeatSumsPort = null;
    }
    try {
      this.adminAuditPort = this.moduleRef.get<AdminAuditTxRunner>(ADMIN_AUDIT_PORT, {
        strict: false,
      });
    } catch {
      this.adminAuditPort = null;
    }
    if (!this.adminAuditPort) {
      this.logger.warn(
        'ADMIN_AUDIT_PORT is not bound in InventoryService; departure_close/reopen will fail closed with 503.',
      );
    }
  }

  private async withRunner<T>(
    tx: InventoryDbRunner | undefined,
    fn: (runner: InventoryDbRunner) => Promise<T>,
  ): Promise<T> {
    if (tx) {
      return fn(tx);
    }
    return this.db.transaction(async (innerTx) => fn(innerTx));
  }

  /**
   * Atomically reserve capacity for a departure under PostgreSQL invariants.
   * Safe to invoke concurrently or inside a caller-supplied DB transaction.
   */
  async allocate(input: AllocateInput, tx?: InventoryDbRunner): Promise<AllocateResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw inventoryInvalidQueryException('quantity must be a positive integer');
    }
    const refType = typeof input.refType === 'string' ? input.refType.trim() : '';
    const refId = typeof input.refId === 'string' ? input.refId.trim() : '';
    if (!refType || !refId) {
      throw inventoryInvalidQueryException('refType and refId must be non-empty strings');
    }
    if (!UUID_REGEX.test(input.departureId)) {
      return { status: 'not_found' };
    }

    return this.withRunner(tx, async (runner) => {
      // Serialize concurrent calls for the same (departureId, refType, refId) so idempotent
      // retries never cause a 23505 unique violation that aborts an outer transaction.
      await runner.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.departureId}:${refType}`}), hashtext(${refId}))`,
      );

      const existingAlloc = await runner.execute(sql`
        SELECT
          id,
          departure_id AS "departureId",
          quantity,
          ref_type AS "refType",
          ref_id AS "refId",
          state,
          created_at AS "createdAt"
        FROM inventory.allocations
        WHERE departure_id = ${input.departureId}::uuid
          AND ref_type = ${refType}
          AND ref_id = ${refId}
        LIMIT 1
      `);

      const foundAlloc = existingAlloc.rows[0];
      if (foundAlloc) {
        const state = String(foundAlloc['state']) as AllocationState;
        if (state === 'released') {
          throw inventoryAllocationAlreadyReleasedException();
        }
        const existingQuantity = Number(foundAlloc['quantity']);
        if (existingQuantity !== input.quantity) {
          throw inventoryAllocationQuantityConflictException(existingQuantity, input.quantity);
        }

        const depRes = await runner.execute(sql`
          SELECT id, capacity, allocated
          FROM inventory.departures
          WHERE id = ${input.departureId}::uuid
        `);
        const depRow = depRes.rows[0];
        if (!depRow) {
          return { status: 'not_found' };
        }
        const capacity = Number(depRow['capacity']);
        const allocated = Number(depRow['allocated']);

        return {
          status: 'allocated',
          allocation: {
            id: String(foundAlloc['id']),
            departureId: String(foundAlloc['departureId']),
            quantity: existingQuantity,
            refType: String(foundAlloc['refType']),
            refId: String(foundAlloc['refId']),
            state,
            createdAt: toIsoTimestamp(foundAlloc['createdAt']),
          },
          departure: {
            id: String(depRow['id']),
            capacity,
            allocated,
            remaining: Math.max(0, capacity - allocated),
          },
        };
      }

      const updateRes = await runner.execute(sql`
        UPDATE inventory.departures
        SET allocated = allocated + ${input.quantity},
            updated_at = now()
        WHERE id = ${input.departureId}::uuid
          AND status = 'open'
          AND allocated + ${input.quantity} <= capacity
          AND now() <= starts_at - make_interval(mins => booking_cutoff_minutes)
        RETURNING id, capacity, allocated
      `);

      const updatedDep = updateRes.rows[0];
      if (!updatedDep) {
        const inspectRes = await runner.execute(sql`
          SELECT
            status,
            (now() <= starts_at - make_interval(mins => booking_cutoff_minutes)) AS "withinCutoff"
          FROM inventory.departures
          WHERE id = ${input.departureId}::uuid
        `);
        const depInfo = inspectRes.rows[0];
        if (!depInfo) {
          return { status: 'not_found' };
        }
        const depStatus = String(depInfo['status']);
        if (depStatus === 'closed' || depStatus === 'cancelled') {
          return { status: 'closed' };
        }
        if (depInfo['withinCutoff'] !== true) {
          return { status: 'cutoff_passed' };
        }
        return { status: 'sold_out' };
      }

      const allocationId = uuidv7();
      const insertRes = await runner.execute(sql`
        INSERT INTO inventory.allocations (id, departure_id, quantity, ref_type, ref_id, state)
        VALUES (${allocationId}::uuid, ${input.departureId}::uuid, ${input.quantity}, ${refType}, ${refId}, 'active')
        RETURNING created_at AS "createdAt"
      `);
      const inserted = insertRes.rows[0] as Record<string, unknown>;
      const capacity = Number(updatedDep['capacity']);
      const allocated = Number(updatedDep['allocated']);

      return {
        status: 'allocated',
        allocation: {
          id: allocationId,
          departureId: input.departureId,
          quantity: input.quantity,
          refType,
          refId,
          state: 'active',
          createdAt: toIsoTimestamp(inserted['createdAt']),
        },
        departure: {
          id: String(updatedDep['id']),
          capacity,
          allocated,
          remaining: Math.max(0, capacity - allocated),
        },
      };
    });
  }

  /**
   * Idempotently release an active allocation and restore departure capacity.
   */
  async release(input: ReleaseInput, tx?: InventoryDbRunner): Promise<ReleaseResult> {
    const refType = typeof input.refType === 'string' ? input.refType.trim() : '';
    const refId = typeof input.refId === 'string' ? input.refId.trim() : '';
    if (!refType || !refId) {
      throw inventoryInvalidQueryException('refType and refId must be non-empty strings');
    }
    if (!UUID_REGEX.test(input.departureId)) {
      return { released: false, quantity: 0 };
    }

    return this.withRunner(tx, async (runner) => {
      await runner.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.departureId}:${refType}`}), hashtext(${refId}))`,
      );

      const releaseRes = await runner.execute(sql`
        UPDATE inventory.allocations
        SET state = 'released',
            released_at = now()
        WHERE departure_id = ${input.departureId}::uuid
          AND ref_type = ${refType}
          AND ref_id = ${refId}
          AND state = 'active'
        RETURNING quantity
      `);

      const releasedRow = releaseRes.rows[0];
      if (!releasedRow) {
        return { released: false, quantity: 0 };
      }

      const quantity = Number(releasedRow['quantity']);
      await runner.execute(sql`
        UPDATE inventory.departures
        SET allocated = allocated - ${quantity},
            updated_at = now()
        WHERE id = ${input.departureId}::uuid
      `);

      return { released: true, quantity };
    });
  }

  async generateDepartures(
    productId: string,
    input: GenerateDeparturesInput,
  ): Promise<GenerateDeparturesResult> {
    if (input.productId !== undefined && input.productId !== productId) {
      throw inventoryInvalidQueryException('body productId must match route productId');
    }

    const { fromDate, toDate } = parseDateWindow(input.fromDate, input.toDate, MAX_GENERATE_DAYS);

    const rawWeekdays: unknown = input.weekdays;
    if (!Array.isArray(rawWeekdays) || rawWeekdays.length === 0) {
      throw inventoryInvalidQueryException('weekdays must be a non-empty array of integers (1..7)');
    }
    const weekdaySet = new Set<number>();
    for (const wd of rawWeekdays) {
      if (typeof wd !== 'number' || !Number.isInteger(wd) || wd < 1 || wd > 7) {
        throw inventoryInvalidQueryException('each weekday must be an integer between 1 and 7');
      }
      weekdaySet.add(wd);
    }

    const rawLocalTimes: unknown = input.localTimes;
    if (!Array.isArray(rawLocalTimes) || rawLocalTimes.length === 0) {
      throw inventoryInvalidQueryException('localTimes must be a non-empty array');
    }
    const normalizedTimes = [...new Set(rawLocalTimes.map((t) => normalizeLocalTime(t)))];

    if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
      throw inventoryInvalidQueryException('capacity must be a positive integer');
    }
    const cutoffMinutes =
      input.bookingCutoffMinutes !== undefined
        ? input.bookingCutoffMinutes
        : DEFAULT_CUTOFF_MINUTES;
    if (!Number.isInteger(cutoffMinutes) || cutoffMinutes < 0) {
      throw inventoryInvalidQueryException('bookingCutoffMinutes must be a non-negative integer');
    }

    const candidates: Array<{ localDate: string; localTime: string }> = [];
    let current = fromDate;
    while (current <= toDate) {
      if (weekdaySet.has(isoWeekday(current))) {
        for (const lt of normalizedTimes) {
          candidates.push({ localDate: current, localTime: lt });
        }
      }
      current = addDays(current, 1);
    }

    return this.db.transaction(async (tx) => {
      // Lock catalog.products row with FOR SHARE inside our transaction so concurrent
      // updateProduct(timeZone) (FOR UPDATE) serializes cleanly with timeZone reading.
      const product = await this.catalogService.getProductInventoryTarget(productId, tx);
      if (!product) {
        throw catalogProductNotFoundException();
      }
      if (product.kind !== 'tour' && product.kind !== 'activity') {
        throw inventoryUnsupportedProductKindException(product.kind);
      }

      if (candidates.length === 0) {
        return { createdCount: 0, skippedCount: 0, createdIds: [] };
      }

      // Compute starts_at inside PostgreSQL using AT TIME ZONE so DST and IANA rules come
      // strictly from PostgreSQL's tzdata. Round-trip back to detect non-existent local times.
      const resolvedRes = await tx.execute(sql`
        SELECT
          x."localDate" AS "localDate",
          x."localTime" AS "localTime",
          ((x."localDate" || ' ' || x."localTime")::timestamp AT TIME ZONE ${product.timeZone}) AS "startsAt",
          ((((x."localDate" || ' ' || x."localTime")::timestamp AT TIME ZONE ${product.timeZone}) AT TIME ZONE ${product.timeZone}) = (x."localDate" || ' ' || x."localTime")::timestamp) AS "isValidLocalTime"
        FROM jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb) AS x("localDate" text, "localTime" text)
      `);

      const resolvedRows = resolvedRes.rows;
      const invalidSlot = resolvedRows.find((r) => r['isValidLocalTime'] !== true);
      if (invalidSlot) {
        throw inventoryNonExistentLocalTimeException(
          String(invalidSlot['localDate']),
          String(invalidSlot['localTime']),
          product.timeZone,
        );
      }

      const valuesSql = sql.join(
        resolvedRows.map((r) => {
          const id = uuidv7();
          const localDate = String(r['localDate']);
          const localTime = String(r['localTime']);
          const startsAtIso = toIsoTimestamp(r['startsAt']);
          return sql`(${id}::uuid, ${productId}::uuid, ${localDate}::date, ${localTime}::time, ${startsAtIso}::timestamptz, ${input.capacity}, 'open', ${cutoffMinutes})`;
        }),
        sql`, `,
      );

      const insertRes = await tx.execute(sql`
        INSERT INTO inventory.departures
          (id, product_id, local_date, local_time, starts_at, capacity, status, booking_cutoff_minutes)
        VALUES ${valuesSql}
        ON CONFLICT (product_id, starts_at) DO NOTHING
        RETURNING id
      `);

      const createdIds = insertRes.rows.map((r) => String(r['id']));
      return {
        createdCount: createdIds.length,
        skippedCount: resolvedRows.length - createdIds.length,
        createdIds,
      };
    });
  }

  async listAdminDepartures(
    productId: string,
    fromRaw?: string,
    toRaw?: string,
  ): Promise<AdminDepartureListResponse> {
    const product = await this.catalogService.getProductInventoryTarget(productId);
    if (!product) {
      throw catalogProductNotFoundException();
    }
    if (product.kind !== 'tour' && product.kind !== 'activity') {
      throw inventoryUnsupportedProductKindException(product.kind);
    }

    const conditions = [eq(inventoryDepartures.productId, productId)];

    if (fromRaw !== undefined && toRaw !== undefined) {
      const { fromDate, toDate } = parseDateWindow(fromRaw, toRaw, MAX_GENERATE_DAYS);
      conditions.push(gte(inventoryDepartures.localDate, fromDate));
      conditions.push(lte(inventoryDepartures.localDate, toDate));
    } else if (fromRaw !== undefined) {
      try {
        conditions.push(gte(inventoryDepartures.localDate, parseLocalDate(fromRaw)));
      } catch (err) {
        if (err instanceof InvalidDateError) {
          throw inventoryInvalidQueryException(err.message);
        }
        throw err;
      }
    } else if (toRaw !== undefined) {
      try {
        conditions.push(lte(inventoryDepartures.localDate, parseLocalDate(toRaw)));
      } catch (err) {
        if (err instanceof InvalidDateError) {
          throw inventoryInvalidQueryException(err.message);
        }
        throw err;
      }
    }

    const rows = await this.db
      .select()
      .from(inventoryDepartures)
      .where(and(...conditions))
      .orderBy(
        asc(inventoryDepartures.localDate),
        asc(inventoryDepartures.localTime),
        asc(inventoryDepartures.id),
      );

    return {
      items: rows.map(toAdminDepartureDto),
    };
  }

  async updateDeparture(
    departureId: string,
    input: UpdateDepartureInput,
  ): Promise<AdminDepartureDto> {
    if (!UUID_REGEX.test(departureId)) {
      throw inventoryDepartureNotFoundException();
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(inventoryDepartures)
        .where(eq(inventoryDepartures.id, departureId))
        .for('update');

      if (!existing) {
        throw inventoryDepartureNotFoundException();
      }

      const setValues: Record<string, unknown> = {
        updatedAt: sql`now()`,
      };

      if (input.capacity !== undefined) {
        if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
          throw inventoryInvalidQueryException('capacity must be a positive integer');
        }
        if (input.capacity < existing.allocated) {
          throw inventoryCapacityBelowAllocatedException(input.capacity, existing.allocated);
        }
        setValues['capacity'] = input.capacity;
      }

      if (input.status !== undefined) {
        if (input.status !== 'open' && input.status !== 'closed') {
          throw inventoryInvalidQueryException('status in PATCH must be "open" or "closed"');
        }
        if (existing.status === 'cancelled' && input.status === 'open') {
          throw inventoryDepartureAlreadyCancelledException();
        }
        setValues['status'] = input.status;
      }

      if (input.bookingCutoffMinutes !== undefined) {
        if (!Number.isInteger(input.bookingCutoffMinutes) || input.bookingCutoffMinutes < 0) {
          throw inventoryInvalidQueryException(
            'bookingCutoffMinutes must be a non-negative integer',
          );
        }
        setValues['bookingCutoffMinutes'] = input.bookingCutoffMinutes;
      }

      const [updated] = await tx
        .update(inventoryDepartures)
        .set(setValues)
        .where(eq(inventoryDepartures.id, departureId))
        .returning();

      return toAdminDepartureDto(updated!);
    });
  }

  async closeDeparture(
    departureId: string,
    actorUserId = 'system',
    reason?: string,
  ): Promise<AdminDepartureDto> {
    if (!UUID_REGEX.test(departureId)) {
      throw inventoryDepartureNotFoundException();
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(inventoryDepartures)
        .where(eq(inventoryDepartures.id, departureId))
        .for('update');
      if (!existing) {
        throw inventoryDepartureNotFoundException();
      }
      if (existing.status === 'cancelled') {
        throw inventoryDepartureAlreadyCancelledException();
      }
      const [updated] = await tx
        .update(inventoryDepartures)
        .set({ status: 'closed', updatedAt: sql`now()` })
        .where(eq(inventoryDepartures.id, departureId))
        .returning();

      const auditPort = requireAdminAuditPort(
        this.adminAuditPort,
        this.logger,
        'departure_close',
        departureId,
      );
      await auditPort.recordAudit(tx, {
        actorUserId,
        action: 'departure_close',
        targetType: 'departure',
        targetId: departureId,
        reason: reason?.trim() || null,
        requestId: getRequestId() ?? null,
      });

      return toAdminDepartureDto(updated!);
    });
  }

  async reopenDeparture(
    departureId: string,
    actorUserId = 'system',
    reason?: string,
  ): Promise<AdminDepartureDto> {
    if (!UUID_REGEX.test(departureId)) {
      throw inventoryDepartureNotFoundException();
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(inventoryDepartures)
        .where(eq(inventoryDepartures.id, departureId))
        .for('update');
      if (!existing) {
        throw inventoryDepartureNotFoundException();
      }
      if (existing.status === 'cancelled') {
        throw inventoryDepartureAlreadyCancelledException();
      }
      const [updated] = await tx
        .update(inventoryDepartures)
        .set({ status: 'open', updatedAt: sql`now()` })
        .where(eq(inventoryDepartures.id, departureId))
        .returning();

      const auditPort = requireAdminAuditPort(
        this.adminAuditPort,
        this.logger,
        'departure_reopen',
        departureId,
      );
      await auditPort.recordAudit(tx, {
        actorUserId,
        action: 'departure_reopen',
        targetType: 'departure',
        targetId: departureId,
        reason: reason?.trim() || null,
        requestId: getRequestId() ?? null,
      });

      return toAdminDepartureDto(updated!);
    });
  }

  async cancelDeparture(
    departureId: string,
    externalTx?: InventoryDbRunner,
  ): Promise<CancelDepartureResult> {
    if (!UUID_REGEX.test(departureId)) {
      throw inventoryDepartureNotFoundException();
    }

    return this.withRunner(externalTx, async (tx) => {
      const [existing] = await tx
        .select()
        .from(inventoryDepartures)
        .where(eq(inventoryDepartures.id, departureId))
        .for('update');
      if (!existing) {
        throw inventoryDepartureNotFoundException();
      }

      const [updated] = await tx
        .update(inventoryDepartures)
        .set({ status: 'cancelled', updatedAt: sql`now()` })
        .where(eq(inventoryDepartures.id, departureId))
        .returning();

      const countRes = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM inventory.allocations
        WHERE departure_id = ${departureId}::uuid
          AND state = 'active'
      `);
      const cnt = Number((countRes.rows[0] as Record<string, unknown>)['cnt'] ?? 0);

      return {
        departure: toAdminDepartureDto(updated!),
        activeAllocationsCount: cnt,
      };
    });
  }

  async getPublicAvailability(
    productId: string,
    fromRaw?: string,
    toRaw?: string,
  ): Promise<PublicAvailabilityResponse> {
    if (!fromRaw || !toRaw) {
      throw inventoryInvalidQueryException('both "from" and "to" query parameters are required');
    }
    const { fromDate, toDate } = parseDateWindow(fromRaw, toRaw, MAX_PUBLIC_WINDOW_DAYS);

    const visibility = await this.catalogService.getPublicProductVisibility(productId);
    if (!visibility.visible) {
      throw catalogProductNotFoundException();
    }
    if (visibility.kind !== 'tour' && visibility.kind !== 'activity') {
      return { items: [] };
    }

    const res = await this.db.execute(sql`
      SELECT
        id,
        local_date::text AS "localDate",
        to_char(local_time, 'HH24:MI:SS') AS "localTime",
        starts_at AS "startsAt",
        GREATEST(0, capacity - allocated) AS "remaining"
      FROM inventory.departures
      WHERE product_id = ${productId}::uuid
        AND local_date >= ${fromDate}::date
        AND local_date <= ${toDate}::date
        AND status = 'open'
        AND starts_at > now()
        AND now() <= starts_at - make_interval(mins => booking_cutoff_minutes)
      ORDER BY starts_at ASC, id ASC
    `);

    const items: PublicAvailabilityItem[] = res.rows.map((row) => {
      const remaining = Number(row['remaining']);
      return {
        id: String(row['id']),
        localDate: String(row['localDate']),
        localTime: String(row['localTime']),
        startsAt: toIsoTimestamp(row['startsAt']),
        remaining,
        status: remaining > 0 ? 'available' : 'sold_out',
      };
    });

    return { items };
  }

  /**
   * Public inter-module API (L1 carry-over): true if the product has at least one departure.
   */
  async hasDepartures(productId: string, tx?: Pick<DatabaseClient, 'select'>): Promise<boolean> {
    if (!UUID_REGEX.test(productId)) {
      return false;
    }
    const runner = tx ?? this.db;
    const [row] = await runner
      .select({ id: inventoryDepartures.id })
      .from(inventoryDepartures)
      .where(eq(inventoryDepartures.productId, productId))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Public inter-module API: returns departure startsAt together with PostgreSQL DB now().
   */
  async getDepartureStartsAtWithDbNow(
    departureId: string,
    tx?: InventoryDbRunner,
  ): Promise<{ readonly startsAt: Date; readonly dbNow: Date } | null> {
    if (!UUID_REGEX.test(departureId)) {
      return null;
    }
    const runner = tx ?? this.db;
    const res = await runner.execute(sql`
      SELECT
        starts_at AS "startsAt",
        now() AS "dbNow"
      FROM inventory.departures
      WHERE id = ${departureId}::uuid
      LIMIT 1
    `);
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      startsAt: new Date(toIsoTimestamp(row['startsAt'])),
      dbNow: new Date(toIsoTimestamp(row['dbNow'])),
    };
  }

  /**
   * Public inter-module API: returns departure metadata + DB-clock bookability for quoting.
   */
  async getDepartureQuoteTarget(
    departureId: string,
  ): Promise<InventoryDepartureQuoteTarget | null> {
    if (!UUID_REGEX.test(departureId)) {
      return null;
    }
    const res = await this.db.execute(sql`
      SELECT
        id,
        product_id AS "productId",
        local_date::text AS "localDate",
        to_char(local_time, 'HH24:MI:SS') AS "localTime",
        starts_at AS "startsAt",
        capacity,
        allocated,
        status,
        booking_cutoff_minutes AS "bookingCutoffMinutes",
        (
          status = 'open'
          AND starts_at > now()
          AND now() <= starts_at - make_interval(mins => booking_cutoff_minutes)
        ) AS "isBookableNow"
      FROM inventory.departures
      WHERE id = ${departureId}::uuid
      LIMIT 1
    `);
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: String(row['id']),
      productId: String(row['productId']),
      localDate: String(row['localDate']),
      localTime: String(row['localTime']),
      startsAt: toIsoTimestamp(row['startsAt']),
      capacity: Number(row['capacity']),
      allocated: Number(row['allocated']),
      status: String(row['status']) as DepartureStatus,
      bookingCutoffMinutes: Number(row['bookingCutoffMinutes']),
      isBookableNow: row['isBookableNow'] === true,
    };
  }

  /**
   * Public inter-module API: distinct local dates of bookable open departures in the next `windowDays`
   * evaluated against the product's IANA time zone using PostgreSQL now().
   */
  async getUpcomingOpenDepartureDates(
    productId: string,
    timeZone: string,
    windowDays = MAX_PUBLIC_WINDOW_DAYS,
  ): Promise<readonly string[]> {
    if (!UUID_REGEX.test(productId)) {
      return [];
    }
    const res = await this.db.execute(sql`
      SELECT DISTINCT local_date::text AS "localDate"
      FROM inventory.departures
      WHERE product_id = ${productId}::uuid
        AND status = 'open'
        AND starts_at > now()
        AND now() <= starts_at - make_interval(mins => booking_cutoff_minutes)
        AND local_date >= (now() AT TIME ZONE ${timeZone})::date
        AND local_date <= ((now() AT TIME ZONE ${timeZone})::date + ${windowDays}::int)
      ORDER BY "localDate" ASC
    `);
    return res.rows.map((row) => String(row['localDate']));
  }

  /**
   * Batched variant of getUpcomingOpenDepartureDates for catalog list cards.
   */
  async getUpcomingOpenDepartureDatesBatch(
    products: readonly { readonly id: string; readonly timeZone: string }[],
    windowDays = MAX_PUBLIC_WINDOW_DAYS,
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const validProducts = products.filter((p) => UUID_REGEX.test(p.id));
    const map = new Map<string, string[]>();
    if (validProducts.length === 0) {
      return map;
    }

    const res = await this.db.execute(sql`
      SELECT DISTINCT
        p.id::text AS "productId",
        d.local_date::text AS "localDate"
      FROM jsonb_to_recordset(${JSON.stringify(validProducts)}::jsonb) AS p(id uuid, "timeZone" text)
      INNER JOIN inventory.departures d
        ON d.product_id = p.id
      WHERE d.status = 'open'
        AND d.starts_at > now()
        AND now() <= d.starts_at - make_interval(mins => d.booking_cutoff_minutes)
        AND d.local_date >= (now() AT TIME ZONE p."timeZone")::date
        AND d.local_date <= ((now() AT TIME ZONE p."timeZone")::date + ${windowDays}::int)
      ORDER BY "productId" ASC, "localDate" ASC
    `);

    for (const row of res.rows) {
      const productId = String(row['productId']);
      const localDate = String(row['localDate']);
      const existing = map.get(productId);
      if (existing) {
        existing.push(localDate);
      } else {
        map.set(productId, [localDate]);
      }
    }

    return map;
  }

  /**
   * Read-only reconciliation check:
   * 1. `inventory.verify_allocated()` must return zero rows.
   * 2. Every departure's `allocated` must equal active booking seats sum from Booking module.
   *
   * Note: intentionally evaluates current live state (not point-in-time `asOf`),
   * which is appropriate for daily off-peak reconciliation runs.
   */
  async runReconciliationChecks(asOf: Date): Promise<readonly ReconciliationFinding[]> {
    void asOf;
    if (!this.bookingSeatSumsPort) {
      throw new InternalServerErrorException(
        'BOOKING_SEAT_SUMS_PORT is not available for inventory reconciliation.',
      );
    }

    const findings: ReconciliationFinding[] = [];
    const verifyRes = await this.db.execute(sql`
      SELECT departure_id::text AS "departureId", recorded_allocated AS "recordedAllocated", actual_active_allocated::int AS "actualActiveAllocated"
      FROM inventory.verify_allocated()
    `);
    for (const row of verifyRes.rows) {
      findings.push({
        code: 'INVENTORY_VERIFY_ALLOCATED_MISMATCH',
        severity: 'error',
        entityType: 'departure',
        entityId: String(row['departureId']),
        details: {
          recordedAllocated: Number(row['recordedAllocated']),
          actualActiveAllocated: Number(row['actualActiveAllocated']),
        },
      });
    }

    const departures = await this.db
      .select({ id: inventoryDepartures.id, allocated: inventoryDepartures.allocated })
      .from(inventoryDepartures);

    const bookingSeatSums = await this.bookingSeatSumsPort.getActiveSeatSumsByDeparture();
    const depMap = new Map(departures.map((d) => [d.id, d.allocated]));
    const allDepIds = new Set([...depMap.keys(), ...bookingSeatSums.keys()]);

    for (const depId of allDepIds) {
      const inventoryAllocated = depMap.get(depId) ?? 0;
      const bookingSeatsSum = bookingSeatSums.get(depId) ?? 0;
      if (inventoryAllocated !== bookingSeatsSum) {
        findings.push({
          code: 'INVENTORY_BOOKING_SEAT_SUM_MISMATCH',
          severity: 'error',
          entityType: 'departure',
          entityId: depId,
          details: {
            inventoryAllocated,
            bookingSeatsSum,
          },
        });
      }
    }

    return findings;
  }
}
