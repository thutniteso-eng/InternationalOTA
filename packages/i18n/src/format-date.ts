import {
  assertValidTimeZone,
  parseLocalDate,
  toLocalDateTime,
  type LocalDate,
} from '@internationalota/time';

/**
 * Formats a calendar `LocalDate` (`YYYY-MM-DD`) in `locale` without shifting
 * across host time zones.
 */
export function formatLocalDate(
  localDate: LocalDate,
  locale: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const canonical = parseLocalDate(localDate);
  const [yearStr, monthStr, dayStr] = canonical.split('-');
  const year = Number.parseInt(yearStr!, 10);
  const month = Number.parseInt(monthStr!, 10);
  const day = Number.parseInt(dayStr!, 10);

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const formatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options,
    timeZone: 'UTC',
  });

  return formatter.format(utcDate);
}

/**
 * Formats a UTC instant (ISO-8601 string with `Z` or offset) in `locale`
 * projected into the given IANA `timeZone` (DST-aware).
 */
export function formatInstant(
  instantUtc: string,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  assertValidTimeZone(timeZone);
  // Validates both instantUtc and timeZone via @internationalota/time (Temporal)
  toLocalDateTime(instantUtc, timeZone);

  const instantDate = new Date(instantUtc);
  const formatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...options,
    timeZone,
  });

  return formatter.format(instantDate);
}
