import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/index.js';
import { IdentityModule } from '../identity/index.js';
import { InventoryModule } from '../inventory/index.js';
import { PricingAdminController } from './pricing-admin.controller.js';
import { PricingPublicController } from './pricing-public.controller.js';
import { PricingService } from './pricing.service.js';

@Module({
  imports: [IdentityModule, InventoryModule, CatalogModule],
  controllers: [PricingAdminController, PricingPublicController],
  providers: [PricingService, { provide: 'PRICING_SUMMARY_PORT', useExisting: PricingService }],
  exports: [PricingService, 'PRICING_SUMMARY_PORT'],
})
export class PricingModule {}
