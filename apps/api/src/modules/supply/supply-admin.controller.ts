import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import { AuthGuard, Roles, RolesGuard } from '../identity/index.js';
import { supplierValidationException } from './supply.errors.js';
import { SupplyService } from './supply.service.js';
import type {
  CreateSupplierInput,
  SupplierRecord,
  SupplierStatus,
  UpdateSupplierInput,
} from './supply.types.js';

@Controller('admin/suppliers')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class SupplyAdminController {
  constructor(private readonly supplyService: SupplyService) {}

  @Post()
  @Idempotent()
  async create(@Body() body: CreateSupplierInput): Promise<SupplierRecord> {
    return this.supplyService.createSupplier(body);
  }

  @Patch(':id')
  @Idempotent()
  async update(
    @Param('id') id: string,
    @Body() body: UpdateSupplierInput,
  ): Promise<SupplierRecord> {
    return this.supplyService.updateSupplier(id, body);
  }

  @Post(':id/suspend')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async suspend(@Param('id') id: string): Promise<SupplierRecord> {
    return this.supplyService.setSupplierStatus(id, 'suspended');
  }

  @Post(':id/reactivate')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('id') id: string): Promise<SupplierRecord> {
    return this.supplyService.setSupplierStatus(id, 'active');
  }

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<{ items: SupplierRecord[] }> {
    let parsedLimit: number | undefined;
    if (limitRaw !== undefined && limitRaw !== '') {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw supplierValidationException('limit must be an integer between 1 and 100');
      }
      parsedLimit = n;
    }

    const parsedStatus =
      status !== undefined && status !== '' ? (status as SupplierStatus) : undefined;

    const items = await this.supplyService.listSuppliers({
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
    return { items };
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<SupplierRecord> {
    return this.supplyService.getSupplierById(id);
  }
}
