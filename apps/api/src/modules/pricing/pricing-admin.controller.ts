import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import {
  AuthGuard,
  CurrentPrincipal,
  type Principal,
  Roles,
  RolesGuard,
} from '../identity/index.js';
import { PricingService } from './pricing.service.js';
import type {
  AdminCancellationPolicyCollectionResponse,
  AdminCancellationPolicyDto,
  AdminPriceListCollectionResponse,
  AdminPriceListDto,
  CreateCancellationPolicyInput,
  CreatePriceListInput,
} from './pricing.types.js';

@Controller('admin/pricing')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class PricingAdminController {
  constructor(private readonly pricingService: PricingService) {}

  @Post('products/:productId/price-lists')
  @Idempotent()
  async createPriceList(
    @Param('productId') productId: string,
    @Body() body: CreatePriceListInput,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AdminPriceListDto> {
    const actor = principal?.userId ?? 'system';
    return this.pricingService.createPriceList(productId, body, actor);
  }

  @Get('products/:productId/price-lists')
  async listPriceLists(
    @Param('productId') productId: string,
  ): Promise<AdminPriceListCollectionResponse> {
    return this.pricingService.listPriceLists(productId);
  }

  @Post('products/:productId/cancellation-policies')
  @Idempotent()
  async createCancellationPolicy(
    @Param('productId') productId: string,
    @Body() body: CreateCancellationPolicyInput,
  ): Promise<AdminCancellationPolicyDto> {
    return this.pricingService.createCancellationPolicy(productId, body);
  }

  @Get('products/:productId/cancellation-policies')
  async listCancellationPolicies(
    @Param('productId') productId: string,
  ): Promise<AdminCancellationPolicyCollectionResponse> {
    return this.pricingService.listCancellationPolicies(productId);
  }
}
