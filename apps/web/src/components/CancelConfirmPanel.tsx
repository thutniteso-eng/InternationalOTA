'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import { formatCancelPreviewMessage, type BookingCancellationPreviewDto } from '@/lib/booking-api';

export function CancelConfirmPanel({
  locale,
  preview,
  loadingPreview,
  submitting,
  errorMessage,
  onConfirm,
  onKeep,
}: {
  readonly locale: BuiltinLocale;
  readonly preview: BookingCancellationPreviewDto | null;
  readonly loadingPreview: boolean;
  readonly submitting: boolean;
  readonly errorMessage: string | null;
  readonly onConfirm: () => void;
  readonly onKeep: () => void;
}): React.JSX.Element {
  return (
    <section
      className="cancelConfirmPanel"
      aria-live="polite"
      aria-labelledby="cancel-panel-heading"
    >
      <h2 id="cancel-panel-heading" className="sectionHeading">
        {t(locale, 'demo.booking.cancelPanelTitle')}
      </h2>

      {loadingPreview ? (
        <p className="resultMeta">{t(locale, 'demo.booking.cancelPreviewLoading')}</p>
      ) : null}

      {preview ? (
        <p className="cancelPreviewText" data-testid="cancel-preview-text">
          {formatCancelPreviewMessage(preview, locale)}
        </p>
      ) : null}

      {errorMessage ? (
        <div className="errorBox" role="alert">
          {errorMessage}
        </div>
      ) : null}

      <div className="panelActions">
        {preview?.cancellable ? (
          <button
            type="button"
            className="dangerButton"
            disabled={submitting || loadingPreview}
            onClick={onConfirm}
          >
            {submitting
              ? t(locale, 'demo.booking.cancelSubmitting')
              : t(locale, 'demo.booking.cancelConfirmButton')}
          </button>
        ) : null}
        <button type="button" className="secondaryButton" disabled={submitting} onClick={onKeep}>
          {t(locale, 'demo.booking.cancelKeepButton')}
        </button>
      </div>
    </section>
  );
}
