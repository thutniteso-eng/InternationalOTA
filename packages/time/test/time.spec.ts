import { describe, expect, it } from 'vitest';
import {
  addDays,
  InvalidDateError,
  InvalidDateRangeError,
  InvalidTimeZoneError,
  isLocalDate,
  isValidTimeZone,
  nightsBetween,
  parseLocalDate,
  startOfLocalDayUtc,
  toLocalDateTime,
} from '../src/index.ts';

describe('packages/time - Unit Tests', () => {
  describe('LocalDate validation and parsing', () => {
    it('parses valid calendar dates', () => {
      expect(parseLocalDate('2026-12-24')).toBe('2026-12-24');
      expect(parseLocalDate('2024-02-29')).toBe('2024-02-29'); // Leap year
      expect(parseLocalDate('2026-01-01')).toBe('2026-01-01');
    });

    it('rejects invalid date formats', () => {
      expect(() => parseLocalDate('24-12-2026')).toThrow(InvalidDateError);
      expect(() => parseLocalDate('2026/12/24')).toThrow(InvalidDateError);
      expect(() => parseLocalDate('2026-1-1')).toThrow(InvalidDateError);
      expect(() => parseLocalDate('')).toThrow(InvalidDateError);
      expect(() => parseLocalDate('2026-12-24T00:00:00Z')).toThrow(InvalidDateError);
    });

    it('rejects non-existent calendar dates', () => {
      expect(() => parseLocalDate('2026-02-29')).toThrow(InvalidDateError); // 2026 is non-leap year
      expect(() => parseLocalDate('2026-04-31')).toThrow(InvalidDateError); // April has 30 days
      expect(() => parseLocalDate('2026-13-01')).toThrow(InvalidDateError); // Invalid month 13
      expect(() => parseLocalDate('2026-00-10')).toThrow(InvalidDateError); // Invalid month 0
      expect(() => parseLocalDate('2026-05-32')).toThrow(InvalidDateError); // Invalid day 32
    });

    it('checks isLocalDate type guard', () => {
      expect(isLocalDate('2026-12-24')).toBe(true);
      expect(isLocalDate('2024-02-29')).toBe(true);
      expect(isLocalDate('2026-02-29')).toBe(false);
      expect(isLocalDate('invalid')).toBe(false);
      expect(isLocalDate(null)).toBe(false);
      expect(isLocalDate(12345)).toBe(false);
    });
  });

  describe('Time zone validation', () => {
    it('validates standard IANA time zones', () => {
      expect(isValidTimeZone('Europe/Berlin')).toBe(true);
      expect(isValidTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
      expect(isValidTimeZone('America/New_York')).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    });

    it('rejects invalid or malformed time zones', () => {
      expect(isValidTimeZone('Invalid/Zone')).toBe(false);
      expect(isValidTimeZone('NonExistent/City')).toBe(false);
      expect(isValidTimeZone('')).toBe(false);
      expect(isValidTimeZone('   ')).toBe(false);
    });

    it('rejects raw offset strings as time zones (E3)', () => {
      expect(isValidTimeZone('+07:00')).toBe(false);
      expect(isValidTimeZone('-05:00')).toBe(false);
      expect(isValidTimeZone('+00:00')).toBe(false);
      expect(isValidTimeZone('+0700')).toBe(false);
      expect(isValidTimeZone('-0500')).toBe(false);
      expect(isValidTimeZone('+07')).toBe(false);
      expect(isValidTimeZone('-05')).toBe(false);
    });
  });

  describe('nightsBetween', () => {
    it('calculates nights between dates correctly', () => {
      expect(nightsBetween('2026-12-24', '2026-12-25')).toBe(1);
      expect(nightsBetween('2026-12-24', '2026-12-28')).toBe(4);
      expect(nightsBetween('2026-12-24', '2026-12-24')).toBe(0);
    });

    it('calculates nights across month and year boundaries', () => {
      // February to March in non-leap year (2026-02-27 to 2026-03-02 = 3 nights)
      expect(nightsBetween('2026-02-27', '2026-03-02')).toBe(3);
      // Year boundary (2026-12-30 to 2027-01-03 = 4 nights)
      expect(nightsBetween('2026-12-30', '2027-01-03')).toBe(4);
    });

    it('throws InvalidDateRangeError when checkOut < checkIn', () => {
      expect(() => nightsBetween('2026-12-25', '2026-12-24')).toThrow(InvalidDateRangeError);
      expect(() => nightsBetween('2027-01-01', '2026-12-31')).toThrow(InvalidDateRangeError);
    });
  });

  describe('startOfLocalDayUtc and DST transitions', () => {
    it('computes start of day in Asia/Ho_Chi_Minh (UTC+7, no DST)', () => {
      // Midnight in Vietnam (UTC+7) is 17:00 UTC previous day
      const instant = startOfLocalDayUtc('2026-12-24', 'Asia/Ho_Chi_Minh');
      expect(instant).toBe('2026-12-23T17:00:00Z');
    });

    it('handles Europe/Berlin spring-forward DST transition (2026-03-29)', () => {
      // Before DST (CET, UTC+1): 2026-03-29 midnight is 2026-03-28 23:00 UTC
      const startDstDay = startOfLocalDayUtc('2026-03-29', 'Europe/Berlin');
      expect(startDstDay).toBe('2026-03-28T23:00:00Z');

      // After DST (CEST, UTC+2): 2026-03-30 midnight is 2026-03-29 22:00 UTC
      const startNextDay = startOfLocalDayUtc('2026-03-30', 'Europe/Berlin');
      expect(startNextDay).toBe('2026-03-29T22:00:00Z');

      // The spring-forward day is exactly 23 hours long
      const diffMs = new Date(startNextDay).getTime() - new Date(startDstDay).getTime();
      expect(diffMs).toBe(23 * 60 * 60 * 1000);
    });

    it('handles Europe/Berlin fall-back DST transition (2026-10-25)', () => {
      // Before transition (CEST, UTC+2): 2026-10-25 midnight is 2026-10-24 22:00 UTC
      const startDstDay = startOfLocalDayUtc('2026-10-25', 'Europe/Berlin');
      expect(startDstDay).toBe('2026-10-24T22:00:00Z');

      // After transition (CET, UTC+1): 2026-10-26 midnight is 2026-10-25 23:00 UTC
      const startNextDay = startOfLocalDayUtc('2026-10-26', 'Europe/Berlin');
      expect(startNextDay).toBe('2026-10-25T23:00:00Z');

      // The fall-back day is exactly 25 hours long
      const diffMs = new Date(startNextDay).getTime() - new Date(startDstDay).getTime();
      expect(diffMs).toBe(25 * 60 * 60 * 1000);
    });

    it('throws InvalidTimeZoneError for invalid time zone', () => {
      expect(() => startOfLocalDayUtc('2026-12-24', 'Invalid/Zone')).toThrow(InvalidTimeZoneError);
    });
  });

  describe('toLocalDateTime', () => {
    it('converts UTC instant to local date-time in Asia/Ho_Chi_Minh', () => {
      // 2026-12-23T17:00:00Z + 7 hours -> 2026-12-24T00:00:00
      expect(toLocalDateTime('2026-12-23T17:00:00Z', 'Asia/Ho_Chi_Minh')).toBe(
        '2026-12-24T00:00:00',
      );
      // 2026-12-24T05:30:00Z + 7 hours -> 2026-12-24T12:30:00
      expect(toLocalDateTime('2026-12-24T05:30:00Z', 'Asia/Ho_Chi_Minh')).toBe(
        '2026-12-24T12:30:00',
      );
    });

    it('converts UTC instant in Europe/Berlin across DST', () => {
      // During CET (UTC+1)
      expect(toLocalDateTime('2026-03-28T23:00:00Z', 'Europe/Berlin')).toBe('2026-03-29T00:00:00');
      // During CEST (UTC+2)
      expect(toLocalDateTime('2026-03-29T22:00:00Z', 'Europe/Berlin')).toBe('2026-03-30T00:00:00');
    });

    it('throws on invalid timezone or malformed instant', () => {
      expect(() => toLocalDateTime('2026-12-24T00:00:00Z', 'Invalid/Zone')).toThrow(
        InvalidTimeZoneError,
      );
      expect(() => toLocalDateTime('not-an-instant', 'UTC')).toThrow();
    });
  });

  describe('addDays', () => {
    it('adds positive and negative days', () => {
      expect(addDays('2026-12-24', 1)).toBe('2026-12-25');
      expect(addDays('2026-12-24', 7)).toBe('2026-12-31');
      expect(addDays('2026-12-24', 8)).toBe('2027-01-01');
      expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
      expect(addDays('2026-12-24', 0)).toBe('2026-12-24');
    });

    it('handles leap and non-leap years correctly', () => {
      // 2024 is leap year: Feb has 29 days
      expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
      expect(addDays('2024-02-29', 1)).toBe('2024-03-01');

      // 2026 is non-leap year: Feb has 28 days
      expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    });
  });
});
