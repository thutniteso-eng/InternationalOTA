'use client';

import {
  formatCancellationPolicySentences,
  formatLocalDate,
  t,
  type BuiltinLocale,
} from '@internationalota/i18n';
import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { PriceChangedPanel } from '@/components/PriceChangedPanel';
import { VerifyEmailBanner } from '@/components/VerifyEmailBanner';
import { fetchBrowserSession, type AuthSession } from '@/lib/auth-client';
import {
  classifyHoldError,
  formatExactMinor,
  formatPaxStepperLabel,
  generateIdempotencyKey,
  isValidE164Phone,
  type HoldBookingResponseDto,
  type PaxSelection,
  type PublicQuoteWithBands,
} from '@/lib/booking-api';
import {
  formatLocalTimeShort,
  type ProblemDetailsError,
  type PublicQuoteResponse,
} from '@/lib/catalog-api';

interface PendingAttemptKey {
  readonly signature: string;
  readonly key: string;
}

export function BookingCheckoutClient({
  locale,
  departureId,
  productId,
  tourSlug,
  pax,
}: {
  readonly locale: BuiltinLocale;
  readonly departureId: string;
  readonly productId: string;
  readonly tourSlug: string;
  readonly pax: PaxSelection;
}): React.JSX.Element {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  const [quote, setQuote] = useState<PublicQuoteWithBands | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('+84');
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [priceChangedQuote, setPriceChangedQuote] = useState<PublicQuoteResponse | null>(null);
  const [unavailableError, setUnavailableError] = useState<string | null>(null);
  const [tooManyHoldsError, setTooManyHoldsError] = useState<string | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);

  const pendingKeyRef = useRef<PendingAttemptKey | null>(null);

  const backHref = tourSlug ? `/${locale}/tours/${tourSlug}` : `/${locale}`;
  const currentBookPath =
    `/${locale}/book/${encodeURIComponent(departureId)}?adult=${pax.adult}&child=${pax.child}&infant=${pax.infant}&productId=${encodeURIComponent(productId)}` +
    (tourSlug ? `&slug=${encodeURIComponent(tourSlug)}` : '');

  useEffect(() => {
    let active = true;
    async function init(): Promise<void> {
      const sess = await fetchBrowserSession();
      if (!active) {
        return;
      }
      setSession(sess);
      setSessionChecked(true);
      if (sess) {
        setName((cur) => cur || sess.user.name || '');
        setEmail((cur) => cur || sess.user.email || '');
      }
    }
    void init();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!productId) {
      setQuoteLoading(false);
      setQuoteError(t(locale, 'demo.book.missingDeparture'));
      return;
    }

    const controller = new AbortController();
    async function loadQuote(): Promise<void> {
      setQuoteLoading(true);
      setQuoteError(null);
      try {
        const params = new URLSearchParams({
          departureId,
          adult: String(pax.adult),
          child: String(pax.child),
          infant: String(pax.infant),
          locale,
        });
        const res = await fetch(
          `/api/catalog/products/${encodeURIComponent(productId)}/quote?${params.toString()}`,
          { cache: 'no-store', signal: controller.signal },
        );
        if (!res.ok) {
          const problem = (await res.json().catch(() => null)) as ProblemDetailsError | null;
          setQuote(null);
          setQuoteError(problem?.detail ?? t(locale, 'demo.detail.quoteErrorFallback'));
          return;
        }
        const data = (await res.json()) as PublicQuoteWithBands;
        setQuote(data);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setQuoteError(t(locale, 'demo.detail.quoteErrorFallback'));
      } finally {
        if (!controller.signal.aborted) {
          setQuoteLoading(false);
        }
      }
    }

    void loadQuote();
    return () => {
      controller.abort();
    };
  }, [departureId, productId, pax.adult, pax.child, pax.infant, locale]);

  async function submitHoldWithQuote(activeQuote: PublicQuoteResponse): Promise<void> {
    if (!isValidE164Phone(phone)) {
      setPhoneError(t(locale, 'demo.book.phoneInvalid'));
      return;
    }
    setPhoneError(null);
    setSubmitting(true);
    setUnavailableError(null);
    setTooManyHoldsError(null);
    setGenericError(null);

    const payload = {
      departureId,
      pax,
      contact: {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        locale,
      },
      expectedSnapshotHash: activeQuote.snapshotHash,
    };
    const signature = JSON.stringify(payload);
    // Reuse the same Idempotency-Key only across network retries of the exact same payload;
    // any confirmed server error clears the key so subsequent attempts use a fresh key.
    const idemKey =
      pendingKeyRef.current && pendingKeyRef.current.signature === signature
        ? pendingKeyRef.current.key
        : generateIdempotencyKey();
    pendingKeyRef.current = { signature, key: idemKey };

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey,
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 201) {
        pendingKeyRef.current = null;
        const created = (await res.json()) as HoldBookingResponseDto;
        window.location.assign(`/${locale}/bookings/${encodeURIComponent(created.reference)}`);
        return;
      }

      pendingKeyRef.current = null;
      const errBody: unknown = await res.json().catch(() => null);
      const outcome = classifyHoldError(res.status, errBody, locale);

      if (outcome.kind === 'unauthenticated') {
        window.location.assign(
          `/${locale}/sign-in?returnTo=${encodeURIComponent(currentBookPath)}`,
        );
        return;
      }
      if (outcome.kind === 'price_changed') {
        setPriceChangedQuote(outcome.quote);
        return;
      }
      if (outcome.kind === 'unavailable') {
        setPriceChangedQuote(null);
        setUnavailableError(outcome.message);
        return;
      }
      if (outcome.kind === 'too_many_active_holds') {
        setPriceChangedQuote(null);
        setTooManyHoldsError(outcome.message);
        return;
      }
      setGenericError(outcome.message);
    } catch {
      // Network failure leaves pendingKeyRef intact so retry reuses the same key.
      setGenericError(t(locale, 'demo.book.retrySamePriceError'));
    } finally {
      setSubmitting(false);
    }
  }

  function handleFormSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!quote) {
      return;
    }
    void submitHoldWithQuote(quote);
  }

  if (sessionChecked && !session) {
    return (
      <div className="widgetCard">
        <h1 className="pageTitle">{t(locale, 'demo.book.pageTitle')}</h1>
        <p className="pageSubtitle">{t(locale, 'demo.book.signInRequired')}</p>
        <Link
          href={`/${locale}/sign-in?returnTo=${encodeURIComponent(currentBookPath)}`}
          className="primaryButton"
        >
          {t(locale, 'demo.nav.signIn')}
        </Link>
      </div>
    );
  }

  const policySentences = quote
    ? formatCancellationPolicySentences(
        {
          rules: quote.rules,
          weatherClause: quote.weatherClause,
        },
        locale,
      )
    : [];

  return (
    <div className="bookLayout">
      {session && !session.user.emailVerified ? (
        <VerifyEmailBanner locale={locale} email={session.user.email} />
      ) : null}

      <div className="backRow">
        <Link href={backHref} className="backLink">
          {t(locale, 'demo.book.backToTour')}
        </Link>
      </div>

      <h1 className="pageTitle">{t(locale, 'demo.book.pageTitle')}</h1>

      {unavailableError ? (
        <section className="errorBox" role="alert">
          <strong>{t(locale, 'demo.book.unavailableTitle')}</strong>
          <p>{unavailableError}</p>
          <Link href={backHref} className="secondaryButton">
            {t(locale, 'demo.book.backToDateStrip')}
          </Link>
        </section>
      ) : null}

      {tooManyHoldsError ? (
        <section className="errorBox" role="alert">
          <p>{tooManyHoldsError}</p>
          <Link href={`/${locale}/me/bookings`} className="secondaryButton">
            {t(locale, 'demo.book.tooManyHoldsLink')}
          </Link>
        </section>
      ) : null}

      {priceChangedQuote && quote ? (
        <PriceChangedPanel
          locale={locale}
          previousQuote={quote}
          updatedQuote={priceChangedQuote}
          accepting={submitting}
          onAcceptNewPrice={() => {
            const accepted = priceChangedQuote;
            setQuote(accepted);
            setPriceChangedQuote(null);
            void submitHoldWithQuote(accepted);
          }}
          onBack={() => {
            window.location.assign(backHref);
          }}
        />
      ) : null}

      <div className="detailLayout">
        <section className="widgetCard" aria-labelledby="contact-heading">
          <h2 id="contact-heading" className="sectionHeading">
            {t(locale, 'demo.book.contactHeading')}
          </h2>
          <p className="resultMeta">{t(locale, 'demo.book.contactHint')}</p>

          {genericError ? (
            <div className="errorBox" role="alert">
              {genericError}
            </div>
          ) : null}

          <form className="authForm" onSubmit={handleFormSubmit}>
            <div className="fieldGroup">
              <label htmlFor="book-contact-name" className="fieldLabel">
                {t(locale, 'demo.book.nameLabel')}
              </label>
              <input
                id="book-contact-name"
                type="text"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                className="textInput"
              />
            </div>

            <div className="fieldGroup">
              <label htmlFor="book-contact-email" className="fieldLabel">
                {t(locale, 'demo.book.emailLabel')}
              </label>
              <input
                id="book-contact-email"
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className="textInput"
              />
            </div>

            <div className="fieldGroup">
              <label htmlFor="book-contact-phone" className="fieldLabel">
                {t(locale, 'demo.book.phoneLabel')}
              </label>
              <input
                id="book-contact-phone"
                type="tel"
                required
                placeholder={t(locale, 'demo.book.phonePlaceholder')}
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  if (phoneError) {
                    setPhoneError(null);
                  }
                }}
                className="textInput"
              />
              {phoneError ? (
                <p className="fieldError" role="alert">
                  {phoneError}
                </p>
              ) : null}
            </div>

            <button
              type="submit"
              className="primaryButton bookButton"
              disabled={!quote || quoteLoading || submitting}
            >
              {submitting
                ? t(locale, 'demo.book.submittingHold')
                : t(locale, 'demo.book.submitHold')}
            </button>
          </form>
        </section>

        <aside className="widgetCard" aria-labelledby="summary-heading">
          <h2 id="summary-heading" className="sectionHeading">
            {t(locale, 'demo.book.summaryHeading')}
          </h2>

          {quoteLoading ? (
            <p className="resultMeta">{t(locale, 'demo.detail.quoteLoading')}</p>
          ) : null}

          {quoteError ? (
            <div className="errorBox" role="alert">
              {quoteError}
            </div>
          ) : null}

          {quote ? (
            <>
              <p className="resultMeta">
                {t(locale, 'demo.detail.selectedDeparture', {
                  dateTime: `${formatLocalDate(quote.localDate, locale)} ${formatLocalTimeShort(quote.startsAt.slice(11, 19))}`,
                })}
              </p>

              <div className="quoteBreakdown">
                {quote.lines.map((line) => (
                  <div key={line.paxType} className="quoteLineRow">
                    <span>
                      {t(locale, 'demo.detail.quoteLine', {
                        paxLabel: formatPaxStepperLabel(line.paxType, locale, quote.ageBands),
                        quantity: line.quantity,
                      })}
                    </span>
                    <span>{formatExactMinor(line.lineAmountMinor, quote.currency, locale)}</span>
                  </div>
                ))}
                <div className="quoteTotalRow">
                  <span>{t(locale, 'demo.detail.quoteTotal')}</span>
                  <span>{formatExactMinor(quote.totalAmountMinor, quote.currency, locale)}</span>
                </div>
                <p className="quoteMetaNote">
                  {t(locale, 'demo.detail.quoteSeatsRequired', { seats: quote.seats })}
                </p>
              </div>

              <h3 className="dateGroupTitle">{t(locale, 'demo.detail.policyHeading')}</h3>
              <ul className="bulletList">
                {policySentences.map((sentence) => (
                  <li key={sentence}>{sentence}</li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
