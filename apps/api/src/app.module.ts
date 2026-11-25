import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { IdempotencyModule } from './modules/idempotency/index.js';

@Module({
  imports: [DatabaseModule, IdempotencyModule],
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
