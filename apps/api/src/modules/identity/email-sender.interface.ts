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

  sendVerificationEmail(params: { to: string; url: string }): Promise<void> {
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
