import { Temporal } from '@js-temporal/polyfill';
import { InvalidDateError, InvalidDateRangeError, InvalidTimeZoneError } from './errors.ts';

export type LocalDate = string;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function parseLocalDate(str: string): LocalDate {
  if (!DATE_REGEX.test(str)) {
    throw new InvalidDateError(`Invalid date format (expected YYYY-MM-DD): "${str}"`);
  }

  try {
    const plainDate = Temporal.PlainDate.from(str);
    return plainDate.toString();
  } catch (err) {
    throw new InvalidDateError(
      `Invalid calendar date: "${str}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export const localDate = parseLocalDate;

export function isLocalDate(val: unknown): val is LocalDate {
  if (typeof val !== 'string' || !DATE_REGEX.test(val)) {
    return false;
  }
  try {
    Temporal.PlainDate.from(val);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string') {
    return false;
  }
  const trimmed = tz.trim();
  // Reject offset strings (e.g. +07:00, -05:00) which are not IANA zone names
  if (!trimmed || /^[+-]/.test(trimmed)) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) {
    throw new InvalidTimeZoneError(tz);
  }
}

export function nightsBetween(checkIn: LocalDate, checkOut: LocalDate): number {
  const parsedIn = parseLocalDate(checkIn);
  const parsedOut = parseLocalDate(checkOut);

  const dIn = Temporal.PlainDate.from(parsedIn);
  const dOut = Temporal.PlainDate.from(parsedOut);

  if (Temporal.PlainDate.compare(dOut, dIn) < 0) {
    throw new InvalidDateRangeError(
      `checkOut (${parsedOut}) must not be before checkIn (${parsedIn})`,
    );
  }

  return dIn.until(dOut, { largestUnit: 'day' }).days;
}

export function startOfLocalDayUtc(date: LocalDate, tz: string): string {
  const parsed = parseLocalDate(date);
  assertValidTimeZone(tz);

  const plainDate = Temporal.PlainDate.from(parsed);
  const zonedDateTime = plainDate.toZonedDateTime({
    timeZone: tz,
    plainTime: '00:00:00',
  });

  return zonedDateTime.toInstant().toString();
}

export function toLocalDateTime(instantUtc: string, tz: string): string {
  assertValidTimeZone(tz);

  try {
    const instant = Temporal.Instant.from(instantUtc);
    const zdt = instant.toZonedDateTimeISO(tz);
    return zdt.toPlainDateTime().toString();
  } catch (err) {
    throw new Error(
      `Failed to convert instant "${instantUtc}" to local date-time in zone "${tz}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const parsed = parseLocalDate(date);
  const plainDate = Temporal.PlainDate.from(parsed);
  return plainDate.add({ days }).toString();
}
