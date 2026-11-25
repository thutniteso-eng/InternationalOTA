import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/index.js';
import { SupplyAdminController } from './supply-admin.controller.js';
import { SupplyService } from './supply.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [SupplyAdminController],
  providers: [SupplyService],
  exports: [SupplyService],
})
export class SupplyModule {}
