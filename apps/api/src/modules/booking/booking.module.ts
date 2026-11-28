import { Module } from '@nestjs/common';
import { BOOKING_SEAT_SUMS_PORT, LEDGER_BOOKING_EXPECTATION_PORT } from '@internationalota/shared';
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
    {
      provide: BOOKING_SEAT_SUMS_PORT,
      useExisting: BookingService,
    },
    {
      provide: LEDGER_BOOKING_EXPECTATION_PORT,
      useExisting: BookingService,
    },
  ],
  exports: [
    BookingService,
    BOOKING_EXPIRY_WORKER_PORT,
    BOOKING_SEAT_SUMS_PORT,
    LEDGER_BOOKING_EXPECTATION_PORT,
  ],
})
export class BookingModule {}
