'use client';

import { formatLocalDate, t, type BuiltinLocale } from '@internationalota/i18n';
import { useEffect, useMemo, useState } from 'react';
import { QuoteSummaryPanel } from '@/components/QuoteSummaryPanel';
import { fetchBrowserSession } from '@/lib/auth-client';
import {
  applyPaxDelta,
  buildAvailabilityDateStrip,
  formatPaxStepperLabel,
  loadLastPaxSelection,
  MAX_PAX_TOTAL,
  saveLastPaxSelection,
  type PaxSelection,
  type PublicPaxAgeBandDto,
  type PublicQuoteWithBands,
} from '@/lib/booking-api';
import {
  computeAvailabilityWindow,
  formatLocalTimeShort,
  resolveQuoteErrorMessage,
  type ProblemDetailsError,
  type PublicAvailabilityItem,
  type PublicAvailabilityResponse,
} from '@/lib/catalog-api';

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
  productSlug,
  locale,
  timeZone,
  initialFromDate,
  initialToDate,
  initialHasNext,
  initialDepartures,
  initialAgeBands,
}: {
  readonly productId: string;
  readonly productSlug?: string;
  readonly locale: BuiltinLocale;
  readonly timeZone: string;
  readonly initialFromDate: string;
  readonly initialToDate: string;
  readonly initialHasNext: boolean;
  readonly initialDepartures: readonly PublicAvailabilityItem[];
  readonly initialAgeBands?: readonly PublicPaxAgeBandDto[];
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

  const firstAvailableDep = useMemo(
    () => initialDepartures.find((d) => d.status === 'available' && d.remaining > 0) ?? null,
    [initialDepartures],
  );
  const [selectedDate, setSelectedDate] = useState<string>(
    () => firstAvailableDep?.localDate ?? initialFromDate,
  );
  const [selectedDepartureId, setSelectedDepartureId] = useState<string | null>(
    () => firstAvailableDep?.id ?? null,
  );

  const [pax, setPax] = useState<PaxSelection>({ adult: 1, child: 0, infant: 0 });
  const [paxHydrated, setPaxHydrated] = useState(false);

  const [quote, setQuote] = useState<PublicQuoteWithBands | null>(null);
  const [knownAgeBands, setKnownAgeBands] = useState<readonly PublicPaxAgeBandDto[] | undefined>(
    initialAgeBands,
  );
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [bookLoading, setBookLoading] = useState(false);

  useEffect(() => {
    const saved = loadLastPaxSelection();
    if (saved) {
      setPax(saved);
    }
    setPaxHydrated(true);
  }, []);

  useEffect(() => {
    if (paxHydrated) {
      saveLastPaxSelection(pax);
    }
  }, [pax, paxHydrated]);

  const dateStrip = useMemo(
    () => buildAvailabilityDateStrip(fromDate, departures, 14),
    [fromDate, departures],
  );
  const selectedDayDepartures = useMemo(
    () => dateStrip.find((day) => day.localDate === selectedDate)?.departures ?? [],
    [dateStrip, selectedDate],
  );
  const selectedDeparture = useMemo(
    () => departures.find((d) => d.id === selectedDepartureId) ?? null,
    [departures, selectedDepartureId],
  );
  const totalPax = pax.adult + pax.child + pax.infant;
  const activeAgeBands = quote?.ageBands ?? knownAgeBands;

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
      const nextFirstOpen = data.items.find((d) => d.status === 'available' && d.remaining > 0);
      setSelectedDate(nextFirstOpen?.localDate ?? win.fromDate);
      setSelectedDepartureId((prev) => {
        if (prev && data.items.some((d) => d.id === prev && d.status === 'available')) {
          return prev;
        }
        return nextFirstOpen?.id ?? null;
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
          adult: String(pax.adult),
          child: String(pax.child),
          infant: String(pax.infant),
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
        const data = (await res.json()) as PublicQuoteWithBands;
        setQuote(data);
        if (data.ageBands && data.ageBands.length > 0) {
          setKnownAgeBands(data.ageBands);
        }
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
  }, [productId, selectedDepartureId, pax.adult, pax.child, pax.infant, locale]);

  async function handleBookClick(): Promise<void> {
    if (!selectedDepartureId || !quote) {
      return;
    }
    setBookLoading(true);
    saveLastPaxSelection(pax);
    const params = new URLSearchParams({
      adult: String(pax.adult),
      child: String(pax.child),
      infant: String(pax.infant),
      productId,
    });
    if (productSlug) {
      params.set('slug', productSlug);
    }
    const targetBookUrl = `/${locale}/book/${encodeURIComponent(selectedDepartureId)}?${params.toString()}`;
    try {
      const session = await fetchBrowserSession();
      if (!session) {
        window.location.assign(`/${locale}/sign-in?returnTo=${encodeURIComponent(targetBookUrl)}`);
        return;
      }
      window.location.assign(targetBookUrl);
    } finally {
      setBookLoading(false);
    }
  }

  const formattedWindow = t(locale, 'demo.detail.availabilityWindow', {
    from: formatLocalDate(fromDate, locale),
    to: formatLocalDate(toDate, locale),
    timeZone,
  });

  const adultLabel = formatPaxStepperLabel('adult', locale, activeAgeBands);
  const childLabel = formatPaxStepperLabel('child', locale, activeAgeBands);
  const infantLabel = formatPaxStepperLabel('infant', locale, activeAgeBands);

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
            data-testid="window-prev-btn"
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
            data-testid="window-next-btn"
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

        {!availError && departures.length === 0 ? (
          <p className="resultMeta">{t(locale, 'demo.detail.availabilityEmpty')}</p>
        ) : null}

        {!availError && departures.length > 0 ? (
          <>
            <div
              className="dateStrip"
              role="group"
              aria-label={t(locale, 'demo.detail.dateStripLabel')}
            >
              {dateStrip.map((day) => {
                const isDaySelected = day.localDate === selectedDate;
                const hasOpen = day.openCount > 0;
                const chipClass = isDaySelected
                  ? 'dateChip dateChipSelected'
                  : hasOpen
                    ? 'dateChip'
                    : 'dateChip dateChipEmpty';

                return (
                  <button
                    key={day.localDate}
                    type="button"
                    aria-pressed={isDaySelected}
                    className={chipClass}
                    onClick={() => {
                      setSelectedDate(day.localDate);
                      const firstOpen = day.departures.find(
                        (d) => d.status === 'available' && d.remaining > 0,
                      );
                      setSelectedDepartureId(firstOpen?.id ?? null);
                    }}
                  >
                    <span className="dateChipLabel">
                      {formatLocalDate(day.localDate, locale, {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'numeric',
                      })}
                    </span>
                    <span className="dateChipMeta">
                      {t(locale, 'demo.detail.dateSlotCount', { count: day.openCount })}
                    </span>
                  </button>
                );
              })}
            </div>

            {selectedDayDepartures.length === 0 ? (
              <p className="resultMeta">{t(locale, 'demo.detail.noSlotsOnDate')}</p>
            ) : (
              <div className="slotGrid">
                {selectedDayDepartures.map((dep) => {
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
            )}
          </>
        ) : null}
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
              disabled={pax.adult <= 1}
              onClick={() => {
                setPax((cur) => applyPaxDelta(cur, 'adult', -1));
              }}
            >
              <span aria-hidden="true">-</span>
            </button>
            <span className="stepperValue" data-testid="pax-adult">
              {pax.adult}
            </span>
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.increase', { label: adultLabel })}
              disabled={totalPax >= MAX_PAX_TOTAL}
              onClick={() => {
                setPax((cur) => applyPaxDelta(cur, 'adult', 1));
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
              disabled={pax.child <= 0}
              onClick={() => {
                setPax((cur) => applyPaxDelta(cur, 'child', -1));
              }}
            >
              <span aria-hidden="true">-</span>
            </button>
            <span className="stepperValue" data-testid="pax-child">
              {pax.child}
            </span>
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.increase', { label: childLabel })}
              disabled={totalPax >= MAX_PAX_TOTAL}
              onClick={() => {
                setPax((cur) => applyPaxDelta(cur, 'child', 1));
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
              disabled={pax.infant <= 0}
              onClick={() => {
                setPax((cur) => applyPaxDelta(cur, 'infant', -1));
              }}
            >
              <span aria-hidden="true">-</span>
            </button>
            <span className="stepperValue" data-testid="pax-infant">
              {pax.infant}
            </span>
            <button
              type="button"
              className="stepperBtn"
              aria-label={t(locale, 'demo.detail.stepper.increase', { label: infantLabel })}
              disabled={totalPax >= MAX_PAX_TOTAL}
              onClick={() => {
                setPax((cur) => applyPaxDelta(cur, 'infant', 1));
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
          canBook={Boolean(selectedDepartureId && quote)}
          bookLoading={bookLoading}
          onBookClick={() => {
            void handleBookClick();
          }}
        />
      </section>
    </aside>
  );
}
