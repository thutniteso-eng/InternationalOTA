import { Module } from '@nestjs/common';
import {
  BOOKING_PAYMENT_SUMMARY_PORT,
  BookingModule,
  CONFIRMED_BOOKING_CANCELLATION_PORT,
} from '../booking/index.js';
import { FinanceModule } from '../finance/index.js';
import { IdentityModule } from '../identity/index.js';
import { InventoryModule } from '../inventory/index.js';
import {
  DEPARTURE_BOOKING_CANCEL_WORKER_PORT,
  MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT,
  MessagingModule,
  PAYMENT_RECONCILIATION_WORKER_PORT,
  REFUND_EXECUTOR_WORKER_PORT,
} from '../messaging/index.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { MockPspController } from './mock-psp.controller.js';
import { PaymentProviderRegistry } from './payment-provider.registry.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RefundAdminController } from './refund-admin.controller.js';
import { RefundService } from './refund.service.js';

@Module({
  imports: [IdentityModule, BookingModule, InventoryModule, FinanceModule, MessagingModule],
  controllers: [PaymentsController, MockPspController, RefundAdminController],
  providers: [
    PaymentProviderRegistry,
    MockPaymentProvider,
    RefundService,
    PaymentsService,
    {
      provide: BOOKING_PAYMENT_SUMMARY_PORT,
      useExisting: PaymentsService,
    },
    {
      provide: CONFIRMED_BOOKING_CANCELLATION_PORT,
      useExisting: RefundService,
    },
    {
      provide: PAYMENT_RECONCILIATION_WORKER_PORT,
      useExisting: PaymentsService,
    },
    {
      provide: MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT,
      useExisting: MockPaymentProvider,
    },
    {
      provide: REFUND_EXECUTOR_WORKER_PORT,
      useExisting: RefundService,
    },
    {
      provide: DEPARTURE_BOOKING_CANCEL_WORKER_PORT,
      useExisting: RefundService,
    },
  ],
  exports: [
    PaymentsService,
    RefundService,
    PaymentProviderRegistry,
    MockPaymentProvider,
    BOOKING_PAYMENT_SUMMARY_PORT,
    CONFIRMED_BOOKING_CANCELLATION_PORT,
    PAYMENT_RECONCILIATION_WORKER_PORT,
    MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT,
    REFUND_EXECUTOR_WORKER_PORT,
    DEPARTURE_BOOKING_CANCEL_WORKER_PORT,
  ],
})
export class PaymentsModule {}
