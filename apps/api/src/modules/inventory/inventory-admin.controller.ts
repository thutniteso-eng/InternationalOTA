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
import { InventoryService } from './inventory.service.js';
import type {
  AdminDepartureDto,
  AdminDepartureListResponse,
  CancelDepartureResult,
  GenerateDeparturesInput,
  GenerateDeparturesResult,
  UpdateDepartureInput,
} from './inventory.types.js';

@Controller('admin/inventory')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class InventoryAdminController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('products/:productId/departures/generate')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async generateDepartures(
    @Param('productId') productId: string,
    @Body() body: GenerateDeparturesInput,
  ): Promise<GenerateDeparturesResult> {
    return this.inventoryService.generateDepartures(productId, body);
  }

  @Get('products/:productId/departures')
  async listDepartures(
    @Param('productId') productId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AdminDepartureListResponse> {
    return this.inventoryService.listAdminDepartures(productId, from, to);
  }

  @Patch('departures/:departureId')
  @Idempotent()
  async updateDeparture(
    @Param('departureId') departureId: string,
    @Body() body: UpdateDepartureInput,
  ): Promise<AdminDepartureDto> {
    return this.inventoryService.updateDeparture(departureId, body);
  }

  @Post('departures/:departureId/close')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async closeDeparture(@Param('departureId') departureId: string): Promise<AdminDepartureDto> {
    return this.inventoryService.closeDeparture(departureId);
  }

  @Post('departures/:departureId/reopen')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async reopenDeparture(@Param('departureId') departureId: string): Promise<AdminDepartureDto> {
    return this.inventoryService.reopenDeparture(departureId);
  }

  @Post('departures/:departureId/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async cancelDeparture(@Param('departureId') departureId: string): Promise<CancelDepartureResult> {
    return this.inventoryService.cancelDeparture(departureId);
  }
}
