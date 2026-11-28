import { ADMIN_AUDIT_PORT, OPS_RECONCILIATION_WORKER_PORT } from '@internationalota/shared';
import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/index.js';
import { FinanceModule } from '../finance/index.js';
import { IdentityModule } from '../identity/index.js';
import { InventoryModule } from '../inventory/index.js';
import { MessagingModule } from '../messaging/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { PaymentsModule } from '../payments/index.js';
import { OpsAdminController } from './ops-admin.controller.js';
import { OpsService } from './ops.service.js';

@Module({
  imports: [
    IdentityModule,
    MessagingModule,
    FinanceModule,
    InventoryModule,
    BookingModule,
    PaymentsModule,
    NotificationsModule,
  ],
  controllers: [OpsAdminController],
  providers: [
    OpsService,
    {
      provide: ADMIN_AUDIT_PORT,
      useExisting: OpsService,
    },
    {
      provide: OPS_RECONCILIATION_WORKER_PORT,
      useExisting: OpsService,
    },
  ],
  exports: [OpsService, ADMIN_AUDIT_PORT, OPS_RECONCILIATION_WORKER_PORT],
})
export class OpsModule {}
