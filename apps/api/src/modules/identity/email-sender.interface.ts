import { Injectable, Logger } from '@nestjs/common';

export const EMAIL_SENDER = 'IDENTITY_EMAIL_SENDER';

export interface EmailSender {
  sendVerificationEmail(params: { to: string; url: string }): Promise<void>;
  sendResetPasswordEmail(params: { to: string; url: string }): Promise<void>;
}

/**
 * Dev/test log-only email sender. Never logs secrets or passwords.
 * Production startup MUST refuse to run if only this sender is configured.
 */
@Injectable()
export class LogOnlyEmailSender implements EmailSender {
  private readonly logger = new Logger(LogOnlyEmailSender.name);
  private delegate: EmailSender | null = null;

  /**
   * Internal hook invoked by `NotificationsModule` on startup to route Identity
   * verification & reset emails through the active `EmailTransport` (`SmtpEmailTransport`).
   */
  setDelegate(delegate: EmailSender | null): void {
    this.delegate = delegate;
  }

  hasDelegate(): boolean {
    return this.delegate !== null;
  }

  sendVerificationEmail(params: { to: string; url: string }): Promise<void> {
    if (this.delegate) {
      return this.delegate.sendVerificationEmail(params);
    }
    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'identity_email_verification_dev_log',
        to: params.to,
        url: params.url,
      }),
    );
    return Promise.resolve();
  }

  sendResetPasswordEmail(params: { to: string; url: string }): Promise<void> {
    if (this.delegate) {
      return this.delegate.sendResetPasswordEmail(params);
    }
    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'identity_password_reset_dev_log',
        to: params.to,
        url: params.url,
      }),
    );
    return Promise.resolve();
  }
}
