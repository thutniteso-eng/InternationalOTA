import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { TestIdempotentCounterController } from './test-idempotent-counter.controller.js';

@Module({
  controllers: process.env.NODE_ENV === 'test' ? [TestIdempotentCounterController] : [],
  providers: [
    IdempotencyInterceptor,
    ProblemDetailsFilter,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
  ],
  exports: [IdempotencyInterceptor, ProblemDetailsFilter],
})
export class IdempotencyModule {
  static forRoot(): DynamicModule {
    return {
      module: IdempotencyModule,
      controllers: process.env.NODE_ENV === 'test' ? [TestIdempotentCounterController] : [],
    };
  }
}
