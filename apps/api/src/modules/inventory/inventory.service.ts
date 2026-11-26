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
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
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
  AdminDepartureDto,
  AdminDepartureListResponse,
  AllocateInput,
  AllocateResult,
  CancelDepartureResult,
  GenerateDeparturesInput,
  GenerateDeparturesResult,
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
export class InventoryService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly catalogService: CatalogService,
  ) {}

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

    const product = await this.catalogService.getProductInventoryTarget(productId);
    if (!product) {
      throw catalogProductNotFoundException();
    }
    if (product.kind !== 'tour' && product.kind !== 'activity') {
      throw inventoryUnsupportedProductKindException(product.kind);
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

    if (candidates.length === 0) {
      return { createdCount: 0, skippedCount: 0, createdIds: [] };
    }

    return this.db.transaction(async (tx) => {
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

  async closeDeparture(departureId: string): Promise<AdminDepartureDto> {
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
      return toAdminDepartureDto(updated!);
    });
  }

  async reopenDeparture(departureId: string): Promise<AdminDepartureDto> {
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
      return toAdminDepartureDto(updated!);
    });
  }

  async cancelDeparture(departureId: string): Promise<CancelDepartureResult> {
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
}
