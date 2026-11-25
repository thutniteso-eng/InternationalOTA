import {
  countries,
  type DatabaseClient,
  desc,
  eq,
  sql,
  SUPPLIER_STATUSES,
  type SupplySupplier,
  supplySuppliers,
  uuidv7,
} from '@internationalota/db';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module.js';
import {
  supplierInvalidCountryException,
  supplierNotFoundException,
  supplierValidationException,
} from './supply.errors.js';
import type {
  CreateSupplierInput,
  ListSuppliersOptions,
  SupplierRecord,
  SupplierStatus,
  UpdateSupplierInput,
} from './supply.types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY_ALPHA2_REGEX = /^[A-Z]{2}$/;
const MAX_ADMIN_SUPPLIER_LIMIT = 100;

function toSupplierRecord(row: SupplySupplier): SupplierRecord {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    countryAlpha2: row.countryAlpha2,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    status: row.status as SupplierStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeOptionalText(val: string | null | undefined): string | null | undefined {
  if (val === undefined) {
    return undefined;
  }
  if (val === null) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

@Injectable()
export class SupplyService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DatabaseClient) {}

  private assertUuid(id: string): void {
    if (!UUID_REGEX.test(id)) {
      throw supplierNotFoundException();
    }
  }

  private async assertCountryExists(rawAlpha2: string): Promise<string> {
    const code = typeof rawAlpha2 === 'string' ? rawAlpha2.trim().toUpperCase() : '';
    if (!COUNTRY_ALPHA2_REGEX.test(code)) {
      throw supplierInvalidCountryException(rawAlpha2 || '');
    }
    const [country] = await this.db
      .select({ alpha2: countries.alpha2 })
      .from(countries)
      .where(eq(countries.alpha2, code));
    if (!country) {
      throw supplierInvalidCountryException(code);
    }
    return code;
  }

  async createSupplier(input: CreateSupplierInput): Promise<SupplierRecord> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw supplierValidationException('name is required');
    }

    const countryAlpha2 = await this.assertCountryExists(input.countryAlpha2);

    const [created] = await this.db
      .insert(supplySuppliers)
      .values({
        id: uuidv7(),
        name,
        legalName: normalizeOptionalText(input.legalName) ?? null,
        countryAlpha2,
        contactEmail: normalizeOptionalText(input.contactEmail) ?? null,
        contactPhone: normalizeOptionalText(input.contactPhone) ?? null,
        status: 'active',
      })
      .returning();

    return toSupplierRecord(created!);
  }

  async updateSupplier(id: string, input: UpdateSupplierInput): Promise<SupplierRecord> {
    this.assertUuid(id);

    const updates: {
      name?: string;
      legalName?: string | null;
      countryAlpha2?: string;
      contactEmail?: string | null;
      contactPhone?: string | null;
      updatedAt: ReturnType<typeof sql>;
    } = {
      updatedAt: sql`now()`,
    };

    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) {
        throw supplierValidationException('name cannot be empty');
      }
      updates.name = name;
    }

    if (input.countryAlpha2 !== undefined) {
      updates.countryAlpha2 = await this.assertCountryExists(input.countryAlpha2);
    }

    if (input.legalName !== undefined) {
      updates.legalName = normalizeOptionalText(input.legalName) ?? null;
    }
    if (input.contactEmail !== undefined) {
      updates.contactEmail = normalizeOptionalText(input.contactEmail) ?? null;
    }
    if (input.contactPhone !== undefined) {
      updates.contactPhone = normalizeOptionalText(input.contactPhone) ?? null;
    }

    const [updated] = await this.db
      .update(supplySuppliers)
      .set(updates)
      .where(eq(supplySuppliers.id, id))
      .returning();

    if (!updated) {
      throw supplierNotFoundException();
    }

    return toSupplierRecord(updated);
  }

  async setSupplierStatus(id: string, status: SupplierStatus): Promise<SupplierRecord> {
    this.assertUuid(id);
    if (!SUPPLIER_STATUSES.includes(status)) {
      throw supplierValidationException(`unsupported status "${status}"`);
    }

    const [updated] = await this.db
      .update(supplySuppliers)
      .set({
        status,
        updatedAt: sql`now()`,
      })
      .where(eq(supplySuppliers.id, id))
      .returning();

    if (!updated) {
      throw supplierNotFoundException();
    }

    return toSupplierRecord(updated);
  }

  async getSupplierById(id: string): Promise<SupplierRecord> {
    this.assertUuid(id);
    const [row] = await this.db.select().from(supplySuppliers).where(eq(supplySuppliers.id, id));
    if (!row) {
      throw supplierNotFoundException();
    }
    return toSupplierRecord(row);
  }

  async listSuppliers(options: ListSuppliersOptions = {}): Promise<SupplierRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_ADMIN_SUPPLIER_LIMIT);
    const baseQuery = this.db.select().from(supplySuppliers);

    if (options.status) {
      if (!SUPPLIER_STATUSES.includes(options.status)) {
        throw supplierValidationException(`unsupported status filter "${options.status}"`);
      }
      const rows = await baseQuery
        .where(eq(supplySuppliers.status, options.status))
        .orderBy(desc(supplySuppliers.createdAt), desc(supplySuppliers.id))
        .limit(limit);
      return rows.map(toSupplierRecord);
    }

    const rows = await baseQuery
      .orderBy(desc(supplySuppliers.createdAt), desc(supplySuppliers.id))
      .limit(limit);
    return rows.map(toSupplierRecord);
  }

  // --- Inter-module public API for sibling modules (catalog, booking, etc.) ---
  // Intentionally omits contactEmail, contactPhone, and legalName.

  async supplierExists(supplierId: string): Promise<boolean> {
    if (!UUID_REGEX.test(supplierId)) {
      return false;
    }
    const [row] = await this.db
      .select({ id: supplySuppliers.id })
      .from(supplySuppliers)
      .where(eq(supplySuppliers.id, supplierId));
    return row !== undefined;
  }

  async isSupplierActive(supplierId: string): Promise<boolean> {
    if (!UUID_REGEX.test(supplierId)) {
      return false;
    }
    const [row] = await this.db
      .select({ status: supplySuppliers.status })
      .from(supplySuppliers)
      .where(eq(supplySuppliers.id, supplierId));
    return row?.status === 'active';
  }

  /**
   * Returns `{ supplierId -> displayName }` exclusively for `active` suppliers.
   * Suspended suppliers are omitted and contact fields are never exposed.
   */
  async getActiveSupplierDisplayMap(): Promise<ReadonlyMap<string, string>> {
    const rows = await this.db
      .select({
        id: supplySuppliers.id,
        name: supplySuppliers.name,
      })
      .from(supplySuppliers)
      .where(eq(supplySuppliers.status, 'active'));

    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async getActiveSupplierDisplayName(supplierId: string): Promise<string | null> {
    if (!UUID_REGEX.test(supplierId)) {
      return null;
    }
    const [row] = await this.db
      .select({
        name: supplySuppliers.name,
        status: supplySuppliers.status,
      })
      .from(supplySuppliers)
      .where(eq(supplySuppliers.id, supplierId));

    return row?.status === 'active' ? row.name : null;
  }
}
