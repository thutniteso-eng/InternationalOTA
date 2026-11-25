import { Controller, Get, Param, Query } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import type { PublicAvailabilityResponse } from './inventory.types.js';

@Controller('catalog/products')
export class InventoryPublicController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get(':productId/availability')
  async getAvailability(
    @Param('productId') productId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<PublicAvailabilityResponse> {
    return this.inventoryService.getPublicAvailability(productId, from, to);
  }
}
