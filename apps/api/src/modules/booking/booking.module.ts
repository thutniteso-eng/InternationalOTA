import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/index.js';
import { InventoryModule } from '../inventory/index.js';
import { BOOKING_EXPIRY_WORKER_PORT, MessagingModule } from '../messaging/index.js';
import { PricingModule } from '../pricing/index.js';
import { BookingAdminController } from './booking-admin.controller.js';
import { BookingController } from './booking.controller.js';
import { BookingService } from './booking.service.js';

@Module({
  imports: [IdentityModule, MessagingModule, InventoryModule, PricingModule],
  controllers: [BookingController, BookingAdminController],
  providers: [
    BookingService,
    {
      provide: BOOKING_EXPIRY_WORKER_PORT,
      useExisting: BookingService,
    },
  ],
  exports: [BookingService, BOOKING_EXPIRY_WORKER_PORT],
})
export class BookingModule {}
