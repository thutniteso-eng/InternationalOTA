export type SupplierStatus = 'active' | 'suspended';

export interface SupplierRecord {
  readonly id: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly countryAlpha2: string;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly status: SupplierStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSupplierInput {
  readonly name: string;
  readonly legalName?: string | null;
  readonly countryAlpha2: string;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
}

export interface UpdateSupplierInput {
  readonly name?: string;
  readonly legalName?: string | null;
  readonly countryAlpha2?: string;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
}

export interface ListSuppliersOptions {
  readonly status?: SupplierStatus;
  readonly limit?: number;
}
