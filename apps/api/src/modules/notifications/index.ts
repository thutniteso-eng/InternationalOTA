export { EmailTemplateRenderer, resolveEmailLocale } from './email-renderer.service.js';
export {
  type CapturedLogEmail,
  EMAIL_TRANSPORT,
  hashRecipientEmail,
  LogEmailTransport,
  redactEmailAddresses,
  resolveSmtpConfigFromEnv,
  SmtpEmailTransport,
} from './email-transport.js';
export { NotificationsEmailSender } from './notifications-email-sender.service.js';
export { NotificationsModule } from './notifications.module.js';
export { NotificationsService } from './notifications.service.js';
export type {
  AdminBookingEmailSummary,
  BookingAdminNotificationPort,
  EmailDeliverySummary,
  EmailSendMessage,
  EmailSendResult,
  EmailTransport,
  RenderedEmailContent,
  SmtpConfig,
  SupportedNotificationTemplate,
} from './notifications.types.js';
