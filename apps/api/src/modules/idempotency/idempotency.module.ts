import { type DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { TestIdempotentCounterController } from './test-idempotent-counter.controller.js';

@Module({
  controllers: process.env.NODE_ENV === 'test' ? [TestIdempotentCounterController] : [],
  providers: [
    IdempotencyInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {
  static forRoot(): DynamicModule {
    return {
      module: IdempotencyModule,
      controllers: process.env.NODE_ENV === 'test' ? [TestIdempotentCounterController] : [],
    };
  }
}
