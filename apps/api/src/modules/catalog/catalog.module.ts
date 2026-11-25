import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/index.js';
import { SupplyModule } from '../supply/index.js';
import { CatalogAdminController } from './catalog-admin.controller.js';
import { CatalogPublicController } from './catalog-public.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({
  imports: [IdentityModule, SupplyModule],
  controllers: [CatalogAdminController, CatalogPublicController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
