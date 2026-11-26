import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/index.js';
import { IdentityModule } from '../identity/index.js';
import { InventoryAdminController } from './inventory-admin.controller.js';
import { InventoryPublicController } from './inventory-public.controller.js';
import { InventoryService } from './inventory.service.js';

@Module({
  imports: [IdentityModule, CatalogModule],
  controllers: [InventoryAdminController, InventoryPublicController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
