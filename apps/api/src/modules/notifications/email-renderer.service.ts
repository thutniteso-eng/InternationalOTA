import {
  formatCancellationPolicySentences,
  formatInstant,
  formatMoney,
  matchLocaleTag,
  BUILTIN_LOCALES,
  t,
} from '@internationalota/i18n';
import { createMoney, type CurrencyCode } from '@internationalota/money';
import { resolveAppEnv } from '@internationalota/shared';
import { Injectable } from '@nestjs/common';
import type { BookingNotificationContext } from '../booking/index.js';
import type { CatalogNotificationProductSummary } from '../catalog/index.js';
import type { RenderedEmailContent } from './notifications.types.js';

const DEFAULT_PUBLIC_WEB_BASE_URL = 'http://localhost:3000';
const DEFAULT_REFUND_BUSINESS_DAYS = 5;

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function resolveWebBaseUrl(): string {
  const raw =
    process.env['PUBLIC_WEB_BASE_URL']?.trim() ||
    process.env['PUBLIC_BASE_URL']?.trim() ||
    DEFAULT_PUBLIC_WEB_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function resolveRefundBusinessDays(): number {
  const raw = process.env['REFUND_PROCESSING_BUSINESS_DAYS']?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REFUND_BUSINESS_DAYS;
}

export function resolveEmailLocale(rawLocale: string | null | undefined): 'vi' | 'en' {
  const matched = rawLocale ? matchLocaleTag(rawLocale, BUILTIN_LOCALES) : undefined;
  return matched === 'en' ? 'en' : 'vi';
}

@Injectable()
export class EmailTemplateRenderer {
  private wrapHtml(
    locale: string,
    heading: string,
    intro: string,
    rows: readonly { readonly label: string; readonly value: string }[],
    extraSectionsHtml: string,
    cta: { readonly label: string; readonly url: string } | null,
  ): string {
    const isProd = resolveAppEnv() === 'production';
    const demoFooter = isProd ? '' : t(locale, 'notifications.email.demoFooter');
    const rowsHtml = rows
      .map(
        (r) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#475569;font-size:14px;">${escapeHtml(r.label)}</td><td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600;">${escapeHtml(r.value)}</td></tr>`,
      )
      .join('');

    const ctaHtml = cta
      ? `<p style="margin:20px 0;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:10px 18px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">${escapeHtml(cta.label)}</a></p>`
      : '';

    const footerHtml = demoFooter
      ? `<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;"/><p style="color:#64748b;font-size:12px;">${escapeHtml(demoFooter)}</p>`
      : '';

    return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#0f172a;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${escapeHtml(heading)}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#334155;">${escapeHtml(intro)}</p>
    ${rowsHtml ? `<table style="border-collapse:collapse;width:100%;margin:12px 0;">${rowsHtml}</table>` : ''}
    ${extraSectionsHtml}
    ${ctaHtml}
    ${footerHtml}
  </div>
</body>
</html>`;
  }

  private wrapText(
    locale: string,
    heading: string,
    intro: string,
    rows: readonly { readonly label: string; readonly value: string }[],
    extraLines: readonly string[],
    cta: { readonly label: string; readonly url: string } | null,
  ): string {
    const isProd = resolveAppEnv() === 'production';
    const lines: string[] = [heading, '', intro, ''];
    for (const r of rows) {
      lines.push(`${r.label}: ${r.value}`);
    }
    if (extraLines.length > 0) {
      lines.push('', ...extraLines);
    }
    if (cta) {
      lines.push('', `${cta.label}: ${cta.url}`);
    }
    if (!isProd) {
      lines.push('', '---', t(locale, 'notifications.email.demoFooter'));
    }
    return lines.join('\n');
  }

  renderIdentityVerification(params: {
    readonly url: string;
    readonly locale?: string;
  }): RenderedEmailContent {
    const locale = resolveEmailLocale(params.locale ?? process.env['DEFAULT_LOCALE']);
    const subject = t(locale, 'notifications.email.identity.verifySubject');
    const intro = t(locale, 'notifications.email.identity.verifyIntro');
    const ctaLabel = t(locale, 'notifications.email.identity.verifyCta');
    const cta = { label: ctaLabel, url: params.url };
    return {
      subject,
      text: this.wrapText(locale, subject, intro, [], [], cta),
      html: this.wrapHtml(locale, subject, intro, [], '', cta),
    };
  }

  renderIdentityResetPassword(params: {
    readonly url: string;
    readonly locale?: string;
  }): RenderedEmailContent {
    const locale = resolveEmailLocale(params.locale ?? process.env['DEFAULT_LOCALE']);
    const subject = t(locale, 'notifications.email.identity.resetSubject');
    const intro = t(locale, 'notifications.email.identity.resetIntro');
    const ctaLabel = t(locale, 'notifications.email.identity.resetCta');
    const cta = { label: ctaLabel, url: params.url };
    return {
      subject,
      text: this.wrapText(locale, subject, intro, [], [], cta),
      html: this.wrapHtml(locale, subject, intro, [], '', cta),
    };
  }

  renderBookingHeld(
    ctx: BookingNotificationContext,
    product: CatalogNotificationProductSummary | null,
  ): RenderedEmailContent {
    const booking = ctx.booking;
    const locale = resolveEmailLocale(booking.contactLocale);
    const tourTitle = product?.title ?? booking.productId;
    const timeZone = product?.timeZone ?? 'Asia/Ho_Chi_Minh';
    const currency = booking.currency.trim() as CurrencyCode;

    const totalFormatted = formatMoney(
      createMoney(BigInt(booking.totalAmountMinor), currency),
      locale,
    );
    const startFormatted = `${formatInstant(booking.quoteSnapshot.startsAt, locale, timeZone)} (${timeZone})`;
    const expiryFormatted = `${formatInstant(booking.holdExpiresAt, locale, timeZone)} (${timeZone})`;
    const paxFormatted = t(locale, 'notifications.email.paxSummary', {
      adult: booking.pax.adult,
      child: booking.pax.child,
      infant: booking.pax.infant,
    });

    const subject = t(locale, 'notifications.email.held.subject', {
      reference: booking.reference,
      tourTitle,
    });
    const greeting = t(locale, 'notifications.email.greeting', { name: booking.contactName });
    const intro = `${greeting} ${t(locale, 'notifications.email.held.intro')}`;

    const rows = [
      { label: t(locale, 'notifications.email.referenceLabel'), value: booking.reference },
      { label: t(locale, 'notifications.email.tourLabel'), value: tourTitle },
      { label: t(locale, 'notifications.email.startTimeLabel'), value: startFormatted },
      { label: t(locale, 'notifications.email.guestsLabel'), value: paxFormatted },
      { label: t(locale, 'notifications.email.totalLabel'), value: totalFormatted },
      { label: t(locale, 'notifications.email.holdExpiresLabel'), value: expiryFormatted },
    ];
    const bookingUrl = `${resolveWebBaseUrl()}/${locale}/bookings/${booking.reference}`;
    const cta = { label: t(locale, 'notifications.email.viewBookingCta'), url: bookingUrl };

    return {
      subject,
      text: this.wrapText(locale, subject, intro, rows, [], cta),
      html: this.wrapHtml(locale, subject, intro, rows, '', cta),
    };
  }

  renderBookingConfirmed(
    ctx: BookingNotificationContext,
    product: CatalogNotificationProductSummary | null,
  ): RenderedEmailContent {
    const booking = ctx.booking;
    const locale = resolveEmailLocale(booking.contactLocale);
    const tourTitle = product?.title ?? booking.productId;
    const timeZone = product?.timeZone ?? 'Asia/Ho_Chi_Minh';
    const currency = booking.currency.trim() as CurrencyCode;

    const totalFormatted = formatMoney(
      createMoney(BigInt(booking.totalAmountMinor), currency),
      locale,
    );
    const startFormatted = `${formatInstant(booking.quoteSnapshot.startsAt, locale, timeZone)} (${timeZone})`;
    const paxFormatted = t(locale, 'notifications.email.paxSummary', {
      adult: booking.pax.adult,
      child: booking.pax.child,
      infant: booking.pax.infant,
    });

    const subject = t(locale, 'notifications.email.confirmed.subject', {
      reference: booking.reference,
      tourTitle,
    });
    const greeting = t(locale, 'notifications.email.greeting', { name: booking.contactName });
    const intro = `${greeting} ${t(locale, 'notifications.email.confirmed.intro')}`;

    const rows = [
      { label: t(locale, 'notifications.email.referenceLabel'), value: booking.reference },
      { label: t(locale, 'notifications.email.tourLabel'), value: tourTitle },
      { label: t(locale, 'notifications.email.startTimeLabel'), value: startFormatted },
      { label: t(locale, 'notifications.email.guestsLabel'), value: paxFormatted },
      { label: t(locale, 'notifications.email.totalLabel'), value: totalFormatted },
      ...(product?.meetingPointNote
        ? [
            {
              label: t(locale, 'notifications.email.meetingPointLabel'),
              value: product.meetingPointNote,
            },
          ]
        : []),
    ];

    const policyLines = formatCancellationPolicySentences(
      {
        rules: booking.quoteSnapshot.rules,
        weatherClause: booking.quoteSnapshot.weatherClause,
      },
      locale,
    );
    const policyHeading = t(locale, 'notifications.email.policyHeading');
    const extraText = [policyHeading, ...policyLines.map((line) => `- ${line}`)];
    const extraHtml = `<h2 style="margin:16px 0 8px;font-size:15px;color:#0f172a;">${escapeHtml(policyHeading)}</h2><ul style="margin:0 0 12px;padding-left:20px;color:#334155;font-size:14px;">${policyLines.map((l) => `<li style="margin:4px 0;">${escapeHtml(l)}</li>`).join('')}</ul>`;

    const bookingUrl = `${resolveWebBaseUrl()}/${locale}/bookings/${booking.reference}`;
    const cta = { label: t(locale, 'notifications.email.viewBookingCta'), url: bookingUrl };

    return {
      subject,
      text: this.wrapText(locale, subject, intro, rows, extraText, cta),
      html: this.wrapHtml(locale, subject, intro, rows, extraHtml, cta),
    };
  }

  renderBookingExpired(
    ctx: BookingNotificationContext,
    product: CatalogNotificationProductSummary | null,
  ): RenderedEmailContent {
    const booking = ctx.booking;
    const locale = resolveEmailLocale(booking.contactLocale);
    const tourTitle = product?.title ?? booking.productId;
    const timeZone = product?.timeZone ?? 'Asia/Ho_Chi_Minh';
    const startFormatted = `${formatInstant(booking.quoteSnapshot.startsAt, locale, timeZone)} (${timeZone})`;

    const subject = t(locale, 'notifications.email.expired.subject', {
      reference: booking.reference,
      tourTitle,
    });
    const greeting = t(locale, 'notifications.email.greeting', { name: booking.contactName });
    const intro = `${greeting} ${t(locale, 'notifications.email.expired.intro', { reference: booking.reference })}`;

    const rows = [
      { label: t(locale, 'notifications.email.referenceLabel'), value: booking.reference },
      { label: t(locale, 'notifications.email.tourLabel'), value: tourTitle },
      { label: t(locale, 'notifications.email.startTimeLabel'), value: startFormatted },
    ];

    const rebookPath = product?.slug ? `/${locale}/tours/${product.slug}` : `/${locale}`;
    const rebookUrl = `${resolveWebBaseUrl()}${rebookPath}`;
    const cta = { label: t(locale, 'notifications.email.rebookCta'), url: rebookUrl };

    return {
      subject,
      text: this.wrapText(locale, subject, intro, rows, [], cta),
      html: this.wrapHtml(locale, subject, intro, rows, '', cta),
    };
  }

  renderBookingCancelled(
    ctx: BookingNotificationContext,
    product: CatalogNotificationProductSummary | null,
  ): RenderedEmailContent {
    const booking = ctx.booking;
    const locale = resolveEmailLocale(booking.contactLocale);
    const tourTitle = product?.title ?? booking.productId;
    const currency = booking.currency.trim() as CurrencyCode;

    const refundMinor = booking.refund ? BigInt(booking.refund.amountMinor) : 0n;
    const totalMinor = BigInt(booking.totalAmountMinor);
    const percent =
      refundMinor > 0n && totalMinor > 0n
        ? Number((refundMinor * 100n + totalMinor / 2n) / totalMinor)
        : 0;
    const refundFormatted = formatMoney(createMoney(refundMinor, currency), locale);

    const subject = t(locale, 'notifications.email.cancelled.subject', {
      reference: booking.reference,
      tourTitle,
    });
    const greeting = t(locale, 'notifications.email.greeting', { name: booking.contactName });
    const introBody =
      refundMinor > 0n
        ? t(locale, 'notifications.email.cancelled.introWithRefund', {
            reference: booking.reference,
            percent,
            refundAmount: refundFormatted,
          })
        : t(locale, 'notifications.email.cancelled.introNoRefund', {
            reference: booking.reference,
          });
    const intro = `${greeting} ${introBody}`;

    const rows = [
      { label: t(locale, 'notifications.email.referenceLabel'), value: booking.reference },
      { label: t(locale, 'notifications.email.tourLabel'), value: tourTitle },
      {
        label: t(locale, 'notifications.email.cancelled.refundLabel'),
        value:
          refundMinor > 0n
            ? `${refundFormatted} (${percent}%)`
            : t(locale, 'notifications.email.cancelled.noRefundValue'),
      },
    ];

    const bookingUrl = `${resolveWebBaseUrl()}/${locale}/bookings/${booking.reference}`;
    const cta = { label: t(locale, 'notifications.email.viewBookingCta'), url: bookingUrl };

    return {
      subject,
      text: this.wrapText(locale, subject, intro, rows, [], cta),
      html: this.wrapHtml(locale, subject, intro, rows, '', cta),
    };
  }

  renderRefundSucceeded(
    ctx: BookingNotificationContext,
    product: CatalogNotificationProductSummary | null,
    refundAmountMinor: bigint,
    currency: CurrencyCode,
  ): RenderedEmailContent {
    const booking = ctx.booking;
    const locale = resolveEmailLocale(booking.contactLocale);
    const tourTitle = product?.title ?? booking.productId;
    const businessDays = resolveRefundBusinessDays();
    const refundFormatted = formatMoney(createMoney(refundAmountMinor, currency), locale);

    const subject = t(locale, 'notifications.email.refundSucceeded.subject', {
      reference: booking.reference,
      refundAmount: refundFormatted,
    });
    const greeting = t(locale, 'notifications.email.greeting', { name: booking.contactName });
    const intro = `${greeting} ${t(locale, 'notifications.email.refundSucceeded.intro', {
      refundAmount: refundFormatted,
      reference: booking.reference,
      businessDays,
    })}`;

    const rows = [
      { label: t(locale, 'notifications.email.referenceLabel'), value: booking.reference },
      { label: t(locale, 'notifications.email.tourLabel'), value: tourTitle },
      {
        label: t(locale, 'notifications.email.refundSucceeded.amountLabel'),
        value: refundFormatted,
      },
    ];

    const bookingUrl = `${resolveWebBaseUrl()}/${locale}/bookings/${booking.reference}`;
    const cta = { label: t(locale, 'notifications.email.viewBookingCta'), url: bookingUrl };

    return {
      subject,
      text: this.wrapText(locale, subject, intro, rows, [], cta),
      html: this.wrapHtml(locale, subject, intro, rows, '', cta),
    };
  }
}
