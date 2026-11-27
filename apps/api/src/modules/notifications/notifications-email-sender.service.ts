import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailSender } from '../identity/index.js';
import { EmailTemplateRenderer } from './email-renderer.service.js';
import { hashRecipientEmail } from './email-transport.js';
import { EMAIL_TRANSPORT, type EmailTransport } from './notifications.types.js';

/**
 * Implements Identity's `EmailSender` port on top of the configured `EmailTransport`
 * (`SmtpEmailTransport` in dev/staging/prod, `LogEmailTransport` in tests when SMTP is unset).
 * Never logs plaintext recipient addresses or verification/reset token URLs.
 */
@Injectable()
export class NotificationsEmailSender implements EmailSender {
  private readonly logger = new Logger(NotificationsEmailSender.name);

  constructor(
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
    private readonly renderer: EmailTemplateRenderer,
  ) {}

  isLogOnly(): boolean {
    return this.transport.isLogTransport === true;
  }

  async sendVerificationEmail(params: { to: string; url: string }): Promise<void> {
    const rendered = this.renderer.renderIdentityVerification({ url: params.url });
    const res = await this.transport.send({
      to: params.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'identity_verification_email_dispatched',
        recipientHash: hashRecipientEmail(params.to),
        messageId: res.messageId,
      }),
    );
  }

  async sendResetPasswordEmail(params: { to: string; url: string }): Promise<void> {
    const rendered = this.renderer.renderIdentityResetPassword({ url: params.url });
    const res = await this.transport.send({
      to: params.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'identity_reset_password_email_dispatched',
        recipientHash: hashRecipientEmail(params.to),
        messageId: res.messageId,
      }),
    );
  }
}
