'use client';

import { formatLocalDate, t, type BuiltinLocale } from '@internationalota/i18n';
import { useEffect, useMemo, useState } from 'react';
import { QuoteSummaryPanel } from '@/components/QuoteSummaryPanel';
import {
  computeAvailabilityWindow,
  formatLocalTimeShort,
  groupDeparturesByDate,
  resolveQuoteErrorMessage,
  type ProblemDetailsError,
  type PublicAvailabilityItem,
  type PublicAvailabilityResponse,
  type PublicQuoteResponse,
} from '@/lib/catalog-api';

const MAX_PAX_TOTAL = 50;
const LOW_SEATS_THRESHOLD = 5;

function seatBadgeLabel(remaining: number, locale: BuiltinLocale): { text: string; low: boolean } {
  if (remaining <= 0) {
    return { text: t(locale, 'demo.detail.soldOut'), low: false };
  }
  if (remaining <= LOW_SEATS_THRESHOLD) {
    return { text: t(locale, 'demo.detail.onlySeatsLeft', { count: remaining }), low: true };
  }
  return { text: t(locale, 'demo.detail.seatsLeft', { count: remaining }), low: false };
}

export function TourAvailabilityQuote({
  productId,
  locale,
  timeZone,
  initialFromDate,
  initialToDate,
  initialHasNext,
  initialDepartures,
}: {
  readonly productId: string;
  readonly locale: BuiltinLocale;
  readonly timeZone: string;
  readonly initialFromDate: string;
  readonly initialToDate: string;
  readonly initialHasNext: boolean;
  readonly initialDepartures: readonly PublicAvailabilityItem[];
}): React.JSX.Element {
  const [windowPage, setWindowPage] = useState(0);
  const [fromDate, setFromDate] = useState(initialFromDate);
  const [toDate, setToDate] = useState(initialToDate);
  const [hasPrev, setHasPrev] = useState(false);
  const [hasNext, setHasNext] = useState(initialHasNext);
  const [departures, setDepartures] =
    useState<readonly PublicAvailabilityItem[]>(initialDepartures);
  const [availLoading, setAvailLoading] = useState(false);
  const [availError, setAvailError] = useState(false);

  const [selectedDepartureId, setSelectedDepartureId] = useState<string | null>(
    () => initialDepartures.find((d) => d.status === 'available')?.id ?? null,
  );

  const [adult, setAdult] = useState(1);
  const [child, setChild] = useState(0);
  const [infant, setInfant] = useState(0);

  const [quote, setQuote] = useState<PublicQuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const grouped = useMemo(() => groupDeparturesByDate(departures), [departures]);
  const selectedDeparture = useMemo(
    () => departures.find((d) => d.id === selectedDepartureId) ?? null,
    [departures, selectedDepartureId],
  );
  const totalPax = adult + child + infant;

  async function loadWindow(nextPage: number): Promise<void> {
    const win = computeAvailabilityWindow(timeZone, nextPage);
    setAvailLoading(true);
    setAvailError(false);
    try {
      const params = new URLSearchParams({ from: win.fromDate, to: win.toDate });
      const res = await fetch(
        `/api/catalog/products/${encodeURIComponent(productId)}/availability?${params.toString()}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        setAvailError(true);
        return;
      }
      const data = (await res.json()) as PublicAvailabilityResponse;
      setWindowPage(nextPage);
      setFromDate(win.fromDate);
      setToDate(win.toDate);
      setHasPrev(win.hasPrev);
      setHasNext(win.hasNext);
      setDepartures(data.items);
      setSelectedDepartureId((prev) => {
        if (prev && data.items.some((d) => d.id === prev && d.status === 'available')) {
          return prev;
        }
        return data.items.find((d) => d.status === 'available')?.id ?? null;
      });
    } catch {
      setAvailError(true);
    } finally {
      setAvailLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedDepartureId) {
      setQuote(null);
      setQuoteError(null);
      return;
    }

    const controller = new AbortController();
    async function runQuote(): Promise<void> {
      setQuoteLoading(true);
      setQuoteError(null);
      try {
        const params = new URLSearchParams({
          departureId: selectedDepartureId!,
          adult: String(adult),
          child: String(child),
          infant: String(infant),
          locale,
        });
        const res = await fetch(
          `/api/catalog/products/${encodeURIComponent(productId)}/quote?${params.toString()}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          const problem = (await res.json().catch(() => null)) as ProblemDetailsError | null;
          setQuote(null);
          setQuoteError(resolveQuoteErrorMessage(problem, locale));
          return;
        }
        const data = (await res.json()) as PublicQuoteResponse;
        setQuote(data);
        setQuoteError(null);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setQuote(null);
        setQuoteError(t(locale, 'demo.detail.quoteErrorFallback'));
      } finally {
        if (!controller.signal.aborted) {
          setQuoteLoading(false);
        }
      }
    }

    void runQuote();
    return () => {
      controller.abort();
    };
  }, [productId, selectedDepartureId, adult, child, infant, locale]);

  const formattedWindow = t(locale, 'demo.detail.availabilityWindow', {
    from: formatLocalDate(fromDate, locale),
    to: formatLocalDate(toDate, locale),
    timeZone,
  });

  const adultLabel = t(locale, 'demo.detail.pax.adult');
  const childLabel = t(locale, 'demo.detail.pax.child');
  const infantLabel = t(locale, 'demo.detail.pax.infant');

  return (
    <aside className="widgetCard">
      <section aria-labelledby="availability-heading">
        <h2 id="availability-heading" className="sectionHeading">
          {t(locale, 'demo.detail.availabilityHeading')}
        </h2>
        <p className="windowRange">{formattedWindow}</p>

        <div className="windowControls">
          <button
            type="button"
            className="secondaryButton"
            disabled={!hasPrev || availLoading}
            onClick={() => {
              void loadWindow(Math.max(0, windowPage - 1));
            }}
          >
            {t(locale, 'demo.detail.availabilityPrev')}
          </button>
          <button
            type="button"
            className="secondaryButton"
            disabled={!hasNext || availLoading}
            onClick={() => {
              void loadWindow(windowPage + 1);
            }}
          >
            {t(locale, 'demo.detail.availabilityNext')}
          </button>
        </div>

        {availError ? (
          <div className="errorBox" role="alert">
            {t(locale, 'demo.detail.availabilityError')}
          </div>
        ) : null}

        {!availError && grouped.length === 0 ? (
          <p className="resultMeta">{t(locale, 'demo.detail.availabilityEmpty')}</p>
        ) : null}

        {grouped.map((group) => (
          <div key={group.localDate} className="dateGroup">
            <h3 className="dateGroupTitle">
              {formatLocalDate(group.localDate, locale, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </h3>
            <div className="slotGrid">
              {group.departures.map((dep) => {
                const isSelected = dep.id === selectedDepartureId;
                const isSoldOut = dep.status === 'sold_out' || dep.remaining <= 0;
                const badge = seatBadgeLabel(dep.remaining, locale);
                const buttonClass = isSoldOut
                  ? 'slotButton slotButtonSoldOut'
                  : isSelected
                    ? 'slotButton slotButtonSelected'
                    : 'slotButton';

                return (
                  <button
                    key={dep.id}
                    type="button"
                    disabled={isSoldOut}
                    aria-pressed={isSelected}
                    className={buttonClass}
                    onClick={() => {
                      setSelectedDepartureId(dep.id);
                    }}
                  >
                    <span className="slotTime">{formatLocalTimeShort(dep.localTime)}</span>
                    <span className={badge.low ? 'slotSeats slotSeatsLow' : 'slotSeats'}>
                      {badge.text}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="quoteSection" aria-labelledby="quote-heading">
        <h2 id="quote-heading" className="sectionHeading">
          {t(locale, 'demo.detail.quoteHeading')}
        </h2>

        {selectedDeparture ? (
          <p className="resultMeta">
            {t(locale, 'demo.detail.selectedDeparture', {
              dateTime: `${formatLocalDate(selectedDeparture.localDate, locale)} ${formatLocalTimeShort(selectedDeparture.localTime)}`,
            })}
          </p>
        ) : (
          <p className="resultMeta">{t(locale, 'demo.detail.selectDeparturePrompt')}</p>
        )}

        <div className="stepperRow">
          <span>{adultLabel}</span>
          <div className="stepperControls">
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.decrease', { label: adultLabel })}
              disabled={adult <= 1}
              onClick={() => {
                setAdult((v) => Math.max(1, v - 1));
              }}
            >
              <span aria-hidden="true">-</span>
            </button>
            <span className="stepperValue" data-testid="pax-adult">
              {adult}
            </span>
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.increase', { label: adultLabel })}
              disabled={totalPax >= MAX_PAX_TOTAL}
              onClick={() => {
                setAdult((v) => (totalPax < MAX_PAX_TOTAL ? v + 1 : v));
              }}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>

        <div className="stepperRow">
          <span>{childLabel}</span>
          <div className="stepperControls">
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.decrease', { label: childLabel })}
              disabled={child <= 0}
              onClick={() => {
                setChild((v) => Math.max(0, v - 1));
              }}
            >
              <span aria-hidden="true">-</span>
            </button>
            <span className="stepperValue" data-testid="pax-child">
              {child}
            </span>
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.increase', { label: childLabel })}
              disabled={totalPax >= MAX_PAX_TOTAL}
              onClick={() => {
                setChild((v) => (totalPax < MAX_PAX_TOTAL ? v + 1 : v));
              }}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>

        <div className="stepperRow">
          <span>{infantLabel}</span>
          <div className="stepperControls">
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.decrease', { label: infantLabel })}
              disabled={infant <= 0}
              onClick={() => {
                setInfant((v) => Math.max(0, v - 1));
              }}
            >
              <span aria-hidden="true">-</span>
            </button>
            <span className="stepperValue" data-testid="pax-infant">
              {infant}
            </span>
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.increase', { label: infantLabel })}
              disabled={totalPax >= MAX_PAX_TOTAL}
              onClick={() => {
                setInfant((v) => (totalPax < MAX_PAX_TOTAL ? v + 1 : v));
              }}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>

        <p className="quoteMetaNote">
          {t(locale, 'demo.detail.pax.adultHint')} ·{' '}
          {t(locale, 'demo.detail.pax.totalCap', { max: MAX_PAX_TOTAL })}
        </p>

        <QuoteSummaryPanel
          locale={locale}
          quote={quote}
          errorMessage={quoteError}
          isLoading={quoteLoading}
        />
      </section>
    </aside>
  );
}
