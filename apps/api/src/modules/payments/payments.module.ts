import { Module } from '@nestjs/common';
import { BookingModule, BOOKING_PAYMENT_SUMMARY_PORT } from '../booking/index.js';
import { FinanceModule } from '../finance/index.js';
import { IdentityModule } from '../identity/index.js';
import {
  MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT,
  MessagingModule,
  PAYMENT_RECONCILIATION_WORKER_PORT,
} from '../messaging/index.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { MockPspController } from './mock-psp.controller.js';
import { PaymentProviderRegistry } from './payment-provider.registry.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [IdentityModule, BookingModule, FinanceModule, MessagingModule],
  controllers: [PaymentsController, MockPspController],
  providers: [
    PaymentProviderRegistry,
    MockPaymentProvider,
    PaymentsService,
    {
      provide: BOOKING_PAYMENT_SUMMARY_PORT,
      useExisting: PaymentsService,
    },
    {
      provide: PAYMENT_RECONCILIATION_WORKER_PORT,
      useExisting: PaymentsService,
    },
    {
      provide: MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT,
      useExisting: MockPaymentProvider,
    },
  ],
  exports: [
    PaymentsService,
    PaymentProviderRegistry,
    MockPaymentProvider,
    BOOKING_PAYMENT_SUMMARY_PORT,
    PAYMENT_RECONCILIATION_WORKER_PORT,
    MOCK_PSP_DELAYED_CALLBACK_WORKER_PORT,
  ],
})
export class PaymentsModule {}
