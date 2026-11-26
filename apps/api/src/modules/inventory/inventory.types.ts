import type { AllocationState, DepartureStatus } from '@internationalota/db';

export type AllocationOutcomeStatus =
  'allocated' | 'sold_out' | 'closed' | 'cutoff_passed' | 'not_found';

export interface AllocateInput {
  readonly departureId: string;
  readonly quantity: number;
  readonly refType: string;
  readonly refId: string;
}

export interface ReleaseInput {
  readonly departureId: string;
  readonly refType: string;
  readonly refId: string;
}

export interface AllocationRecord {
  readonly id: string;
  readonly departureId: string;
  readonly quantity: number;
  readonly refType: string;
  readonly refId: string;
  readonly state: AllocationState;
  readonly createdAt: string;
}

export type AllocateResult =
  | {
      readonly status: 'allocated';
      readonly allocation: AllocationRecord;
      readonly departure: {
        readonly id: string;
        readonly capacity: number;
        readonly allocated: number;
        readonly remaining: number;
      };
    }
  | {
      readonly status: 'sold_out' | 'closed' | 'cutoff_passed' | 'not_found';
    };

export interface ReleaseResult {
  readonly released: boolean;
  readonly quantity: number;
}

export interface GenerateDeparturesInput {
  readonly productId?: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly weekdays: readonly number[];
  readonly localTimes: readonly string[];
  readonly capacity: number;
  readonly bookingCutoffMinutes?: number;
}

export interface GenerateDeparturesResult {
  readonly createdCount: number;
  readonly skippedCount: number;
  readonly createdIds: readonly string[];
}

export interface UpdateDepartureInput {
  readonly capacity?: number;
  readonly status?: 'open' | 'closed';
  readonly bookingCutoffMinutes?: number;
}

export interface AdminDepartureDto {
  readonly id: string;
  readonly productId: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly startsAt: string;
  readonly capacity: number;
  readonly allocated: number;
  readonly remaining: number;
  readonly status: DepartureStatus;
  readonly bookingCutoffMinutes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminDepartureListResponse {
  readonly items: readonly AdminDepartureDto[];
}

export interface CancelDepartureResult {
  readonly departure: AdminDepartureDto;
  readonly activeAllocationsCount: number;
}

export type PublicAvailabilityStatus = 'available' | 'sold_out';

export interface PublicAvailabilityItem {
  readonly id: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly startsAt: string;
  readonly remaining: number;
  readonly status: PublicAvailabilityStatus;
}

export interface PublicAvailabilityResponse {
  readonly items: readonly PublicAvailabilityItem[];
}

export interface InventoryDepartureQuoteTarget {
  readonly id: string;
  readonly productId: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly startsAt: string;
  readonly capacity: number;
  readonly allocated: number;
  readonly status: DepartureStatus;
  readonly bookingCutoffMinutes: number;
  readonly isBookableNow: boolean;
}

export interface InventoryDepartureCheckPort {
  hasDepartures(productId: string): Promise<boolean>;
}
