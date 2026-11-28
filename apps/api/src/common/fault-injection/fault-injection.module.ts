import { resolveAppEnv } from '@internationalota/shared';
import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { FaultInjector } from './fault-injector.service.js';

@Global()
@Module({
  providers: [FaultInjector],
  exports: [FaultInjector],
})
export class FaultInjectionModule implements OnModuleInit {
  onModuleInit(): void {
    if (resolveAppEnv() === 'production') {
      throw new Error('FaultInjectionModule cannot be loaded when APP_ENV=production');
    }
  }
}
