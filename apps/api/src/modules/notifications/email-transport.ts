import { createHash } from 'node:crypto';
import { resolveAppEnv } from '@internationalota/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import {
  EMAIL_TRANSPORT,
  type EmailSendMessage,
  type EmailSendResult,
  type EmailTransport,
  type SmtpConfig,
} from './notifications.types.js';

export { EMAIL_TRANSPORT };

const DEFAULT_NON_PROD_FROM = 'no-reply@internationalota.local';
const EMAIL_PATTERN = /[^\s<>"',;()[\]]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function hashRecipientEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export function redactEmailAddresses(input: string): string {
  return input.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

/**
 * Resolves SMTP configuration from environment variables.
 *
 * Returns `null` when `SMTP_HOST` is unset (allowing `LogEmailTransport` in local/test).
 * Throws an explicit error when `SMTP_HOST` is partially configured with invalid port,
 * mismatched credentials, or missing `MAIL_FROM` in production.
 */
export function resolveSmtpConfigFromEnv(): SmtpConfig | null {
  const appEnv = resolveAppEnv();
  const rawHost = process.env['SMTP_HOST']?.trim() ?? '';
  if (!rawHost) {
    return null;
  }

  const rawPort = process.env['SMTP_PORT']?.trim() ?? '';
  const port = rawPort ? Number(rawPort) : 1025;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SMTP_PORT value "${rawPort}". Expected integer between 1 and 65535.`);
  }

  const rawSecure = process.env['SMTP_SECURE']?.trim().toLowerCase() ?? 'false';
  if (rawSecure !== 'true' && rawSecure !== 'false') {
    throw new Error(`Invalid SMTP_SECURE value "${rawSecure}". Expected "true" or "false".`);
  }
  const secure = rawSecure === 'true';

  const rawFrom = process.env['MAIL_FROM']?.trim() ?? '';
  if (appEnv === 'production' && (!rawFrom || !rawPort)) {
    throw new Error(
      'Refusing to start in production (APP_ENV=production): incomplete SMTP configuration (SMTP_HOST, SMTP_PORT, MAIL_FROM are required).',
    );
  }
  const from = rawFrom || DEFAULT_NON_PROD_FROM;

  const user = process.env['SMTP_USER']?.trim();
  const pass = process.env['SMTP_PASS']?.trim();
  if ((user && !pass) || (!user && pass)) {
    throw new Error('Incomplete SMTP credentials: both SMTP_USER and SMTP_PASS must be provided.');
  }

  return {
    host: rawHost,
    port,
    secure,
    from,
    ...(user && pass ? { user, pass } : {}),
  };
}

/**
 * SMTP email transport backed by `nodemailer` (`D-023`).
 * Never logs plaintext recipient addresses.
 */
export class SmtpEmailTransport implements EmailTransport, OnModuleDestroy {
  readonly isLogTransport = false;
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(private readonly config: SmtpConfig) {
    this.fromAddress = config.from;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user && config.pass
        ? {
            auth: {
              user: config.user,
              pass: config.pass,
            },
          }
        : {}),
    });
  }

  async send(message: EmailSendMessage): Promise<EmailSendResult> {
    const info = await this.transporter.sendMail({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.headers ? { headers: { ...message.headers } } : {}),
    });
    return {
      messageId: info.messageId || `smtp-${Date.now()}`,
    };
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }
}

export interface CapturedLogEmail {
  readonly recipientHash: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Development/test log-only email transport (`SMTP_HOST` unset).
 * Production startup MUST refuse to boot with this transport.
 * Never writes plaintext email addresses to logs.
 */
@Injectable()
export class LogEmailTransport implements EmailTransport {
  readonly isLogTransport = true;
  private readonly logger = new Logger(LogEmailTransport.name);
  private readonly captured: CapturedLogEmail[] = [];

  send(message: EmailSendMessage): Promise<EmailSendResult> {
    const recipientHash = hashRecipientEmail(message.to);
    const messageId = `<log-${recipientHash.slice(0, 12)}-${Date.now()}@log.local>`;
    if (resolveAppEnv() !== 'production') {
      this.captured.push({
        recipientHash,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.headers ? { headers: message.headers } : {}),
      });
    }
    this.logger.log(
      JSON.stringify({
        level: 'info',
        event: 'email_transport_log_only',
        recipientHash,
        messageId,
      }),
    );
    return Promise.resolve({ messageId });
  }

  getCapturedMessages(): readonly CapturedLogEmail[] {
    return this.captured;
  }

  clearCapturedMessages(): void {
    this.captured.length = 0;
  }
}
