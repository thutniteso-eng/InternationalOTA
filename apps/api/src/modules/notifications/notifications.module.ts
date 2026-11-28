import { Module } from '@nestjs/common';
import { BOOKING_ADMIN_NOTIFICATION_PORT } from '@internationalota/shared';
import { BookingModule } from '../booking/index.js';
import { CatalogModule } from '../catalog/index.js';
import { IdentityModule } from '../identity/index.js';
import { MessagingModule, NOTIFICATION_EMAIL_SENDER_WORKER_PORT } from '../messaging/index.js';
import { EmailTemplateRenderer } from './email-renderer.service.js';
import {
  LogEmailTransport,
  resolveSmtpConfigFromEnv,
  SmtpEmailTransport,
} from './email-transport.js';
import { NotificationsEmailSender } from './notifications-email-sender.service.js';
import { NotificationsService } from './notifications.service.js';
import { EMAIL_TRANSPORT } from './notifications.types.js';

@Module({
  imports: [IdentityModule, MessagingModule, BookingModule, CatalogModule],
  providers: [
    EmailTemplateRenderer,
    LogEmailTransport,
    {
      provide: EMAIL_TRANSPORT,
      inject: [LogEmailTransport],
      useFactory: (logTransport: LogEmailTransport) => {
        const config = resolveSmtpConfigFromEnv();
        if (!config) {
          return logTransport;
        }
        return new SmtpEmailTransport(config);
      },
    },
    NotificationsEmailSender,
    NotificationsService,
    {
      provide: NOTIFICATION_EMAIL_SENDER_WORKER_PORT,
      useExisting: NotificationsService,
    },
    {
      provide: BOOKING_ADMIN_NOTIFICATION_PORT,
      useExisting: NotificationsService,
    },
  ],
  exports: [
    EMAIL_TRANSPORT,
    EmailTemplateRenderer,
    NotificationsEmailSender,
    LogEmailTransport,
    NotificationsService,
    NOTIFICATION_EMAIL_SENDER_WORKER_PORT,
    BOOKING_ADMIN_NOTIFICATION_PORT,
  ],
})
export class NotificationsModule {}
