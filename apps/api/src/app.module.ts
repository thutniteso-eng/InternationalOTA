import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { IdempotencyModule } from './modules/idempotency/index.js';

@Module({
  imports: [DatabaseModule, IdempotencyModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
