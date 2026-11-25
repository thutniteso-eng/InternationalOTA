import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { IdempotencyModule } from './modules/idempotency/index.js';
import { IdentityModule } from './modules/identity/index.js';

@Module({
  imports: [DatabaseModule, IdentityModule, IdempotencyModule],
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
