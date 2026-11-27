import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';
import { I18nModule } from './common/i18n/i18n.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { BookingModule } from './modules/booking/index.js';
import { CatalogModule } from './modules/catalog/index.js';
import { FinanceModule } from './modules/finance/index.js';
import { IdempotencyModule } from './modules/idempotency/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { InventoryModule } from './modules/inventory/index.js';
import { MessagingModule } from './modules/messaging/index.js';
import { PaymentsModule } from './modules/payments/index.js';
import { PricingModule } from './modules/pricing/index.js';
import { SupplyModule } from './modules/supply/index.js';

@Module({
  imports: [
    DatabaseModule,
    I18nModule,
    IdentityModule,
    IdempotencyModule,
    MessagingModule,
    FinanceModule,
    SupplyModule,
    // Registered before CatalogModule so /catalog/products/:productId/{quote,availability} match before :locale/:slug.
    PricingModule,
    InventoryModule,
    CatalogModule,
    BookingModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    ProblemDetailsFilter,
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
  ],
})
export class AppModule {}
