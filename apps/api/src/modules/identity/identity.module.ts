import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard.js';
import { EMAIL_SENDER, LogOnlyEmailSender } from './email-sender.interface.js';
import { IdentityService } from './identity.service.js';
import { RolesGuard } from './roles.guard.js';
import { TestIdentityController } from './test-identity.controller.js';

@Module({
  controllers: process.env['NODE_ENV'] === 'test' ? [TestIdentityController] : [],
  providers: [
    LogOnlyEmailSender,
    {
      provide: EMAIL_SENDER,
      useExisting: LogOnlyEmailSender,
    },
    IdentityService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [IdentityService, AuthGuard, RolesGuard, EMAIL_SENDER],
})
export class IdentityModule {}
