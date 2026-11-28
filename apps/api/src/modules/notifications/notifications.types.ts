import type { EmailTemplate } from '@internationalota/db';

export const EMAIL_TRANSPORT = 'NOTIFICATIONS_EMAIL_TRANSPORT';

export interface EmailSendMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EmailSendResult {
  readonly messageId: string;
}

export interface EmailTransport {
  readonly isLogTransport?: boolean;
  send(message: EmailSendMessage): Promise<EmailSendResult>;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly from: string;
  readonly user?: string;
  readonly pass?: string;
}

export interface RenderedEmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailDeliverySummary {
  readonly processedCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly deadCount: number;
}

export type SupportedNotificationTemplate = EmailTemplate;

export interface AdminBookingEmailSummary {
  readonly id: string;
  readonly template: SupportedNotificationTemplate;
  readonly locale: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface BookingAdminNotificationPort {
  getEmailsForBooking(bookingId: string): Promise<readonly AdminBookingEmailSummary[]>;
}
