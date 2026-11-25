import { createMoney } from '@internationalota/money';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatInstant,
  formatLocalDate,
  formatMoney,
  getDefaultLocale,
  matchLocaleTag,
  MissingTranslationKeyError,
  negotiateLocale,
  setI18nWarnLogger,
  t,
} from '../src/index.ts';

describe('@internationalota/i18n', () => {
  afterEach(() => {
    setI18nWarnLogger(undefined);
    vi.unstubAllEnvs();
  });

  describe('AC1: negotiateLocale (RFC 9110 + BCP 47 prefix matching)', () => {
    const enabled = ['vi', 'en'] as const;

    it('matches vi-VN,vi;q=0.9,en;q=0.8 -> vi', () => {
      expect(negotiateLocale('vi-VN,vi;q=0.9,en;q=0.8', enabled, 'vi')).toBe('vi');
    });

    it('matches en-GB -> en via BCP 47 prefix fallback', () => {
      expect(negotiateLocale('en-GB', enabled, 'vi')).toBe('en');
    });

    it('falls back to default for unsupported language fr-FR', () => {
      expect(negotiateLocale('fr-FR', enabled, 'vi')).toBe('vi');
    });

    it('respects q=0 exclusion: en;q=0, vi -> vi', () => {
      expect(negotiateLocale('en;q=0, vi', enabled, 'en')).toBe('vi');
      expect(negotiateLocale('en;q=0, *', enabled, 'en')).toBe('vi');
    });

    it('returns default for malformed headers', () => {
      expect(negotiateLocale(';;;not-valid;;;', enabled, 'vi')).toBe('vi');
      expect(negotiateLocale('en;q=9.9', enabled, 'vi')).toBe('vi');
      expect(negotiateLocale('12345', enabled, 'vi')).toBe('vi');
      expect(negotiateLocale('', enabled, 'vi')).toBe('vi');
      expect(negotiateLocale(undefined, enabled, 'vi')).toBe('vi');
    });

    it('never selects a disabled language (ko)', () => {
      expect(negotiateLocale('ko', enabled, 'vi')).toBe('vi');
      expect(negotiateLocale('ko-KR,ko;q=0.9', enabled, 'vi')).toBe('vi');
      expect(negotiateLocale('ko,en;q=0.5', enabled, 'vi')).toBe('en');
    });

    it('respects q-value ordering when secondary language has higher q', () => {
      expect(negotiateLocale('vi;q=0.4, en-US;q=0.9', enabled, 'vi')).toBe('en');
    });

    it('reads DEFAULT_LOCALE from env when fallback is omitted', () => {
      vi.stubEnv('DEFAULT_LOCALE', 'en');
      expect(getDefaultLocale()).toBe('en');
      expect(negotiateLocale('fr-FR', enabled)).toBe('en');
    });

    it('matchLocaleTag matches explicit locale tags against enabled list', () => {
      expect(matchLocaleTag('en-US', enabled)).toBe('en');
      expect(matchLocaleTag('vi-VN', enabled)).toBe('vi');
      expect(matchLocaleTag('ko', enabled)).toBeUndefined();
      expect(matchLocaleTag('bad tag!', enabled)).toBeUndefined();
    });
  });

  describe('t() ICU MessageFormat & unknown key behavior', () => {
    it('formats plain messages, variables, plurals, and numbers in vi and en', () => {
      expect(t('vi', 'common.greeting', { name: 'Lan' })).toBe('Xin chào, Lan!');
      expect(t('en', 'common.greeting', { name: 'Lan' })).toBe('Hello, Lan!');

      expect(t('en', 'home.destinationCount', { count: 0 })).toBe('No destinations available');
      expect(t('en', 'home.destinationCount', { count: 1 })).toBe('1 destination available');
      expect(t('en', 'home.destinationCount', { count: 5 })).toBe('5 destinations available');

      expect(t('vi', 'home.destinationCount', { count: 0 })).toBe('Chưa có điểm đến nào');
      expect(t('vi', 'home.destinationCount', { count: 5 })).toBe('Hiện có 5 điểm đến sẵn sàng');
    });

    it('throws MissingTranslationKeyError on unknown key in dev/test', () => {
      vi.stubEnv('NODE_ENV', 'test');
      expect(() => t('en', 'does.not.exist')).toThrow(MissingTranslationKeyError);
    });

    it('returns the key and logs a WARN on unknown key in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const warnSpy = vi.fn();
      setI18nWarnLogger(warnSpy);

      const result = t('vi', 'unknown.prod.key');
      expect(result).toBe('unknown.prod.key');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown.prod.key'), {
        locale: 'vi',
        key: 'unknown.prod.key',
      });
    });
  });

  describe('AC3: formatMoney (forced exponents + bigint precision beyond MAX_SAFE_INTEGER)', () => {
    it('formats VND (0 decimals), USD (2 decimals), and KWD (3 decimals) in both locales', () => {
      const vnd = createMoney(1500000n, 'VND');
      const usd = createMoney(12345n, 'USD');
      const kwd = { amountMinor: 12345n, currency: 'KWD' } as const;

      // VND: 0 fraction digits in both locales
      const vndEn = formatMoney(vnd, 'en');
      const vndVi = formatMoney(vnd, 'vi');
      expect(vndEn).toContain('1,500,000');
      expect(vndEn).not.toMatch(/\.\d+/);
      expect(vndVi).toContain('1.500.000');
      expect(vndVi).not.toMatch(/,\d+/);

      // USD: 2 fraction digits in both locales
      expect(formatMoney(usd, 'en')).toContain('123.45');
      expect(formatMoney(usd, 'vi')).toContain('123,45');

      // KWD: 3 fraction digits in both locales
      expect(formatMoney(kwd, 'en')).toContain('12.345');
      expect(formatMoney(kwd, 'vi')).toContain('12,345');
    });

    it('formats 9007199254740993n minor units exactly with zero precision loss', () => {
      // Number(9007199254740993n) would round to 9007199254740992 — last digit MUST remain 3!
      const hugeVnd = createMoney(9007199254740993n, 'VND');
      expect(formatMoney(hugeVnd, 'en')).toContain('9,007,199,254,740,993');
      expect(formatMoney(hugeVnd, 'vi')).toContain('9.007.199.254.740.993');

      const hugeUsd = createMoney(9007199254740993n, 'USD');
      expect(formatMoney(hugeUsd, 'en')).toContain('90,071,992,547,409.93');
      expect(formatMoney(hugeUsd, 'vi')).toContain('90.071.992.547.409,93');

      const hugeKwd = { amountMinor: 9007199254740993n, currency: 'KWD' } as const;
      expect(formatMoney(hugeKwd, 'en')).toContain('9,007,199,254,740.993');
      expect(formatMoney(hugeKwd, 'vi')).toContain('9.007.199.254.740,993');
    });
  });

  describe('AC4: formatLocalDate and formatInstant (IANA zones + DST)', () => {
    it('formats LocalDate consistently without host timezone shift', () => {
      const en = formatLocalDate('2026-07-15', 'en-US');
      expect(en).toContain('2026');
      expect(en).toContain('15');

      const viStr = formatLocalDate('2026-07-15', 'vi-VN');
      expect(viStr).toContain('2026');
      expect(viStr).toContain('15');
    });

    it('formats UTC instant in Asia/Ho_Chi_Minh (UTC+7)', () => {
      const formatted = formatInstant('2026-06-15T10:30:00Z', 'en-GB', 'Asia/Ho_Chi_Minh');
      expect(formatted).toContain('15');
      expect(formatted).toContain('2026');
      expect(formatted).toContain('17:30:00');
    });

    it('formats UTC instants accurately across Europe/Berlin spring-forward DST change', () => {
      // 2026-03-29: Europe/Berlin springs forward at 01:00 UTC (02:00 CET -> 03:00 CEST)
      const beforeDst = formatInstant('2026-03-29T00:30:00Z', 'en-GB', 'Europe/Berlin');
      const afterDst = formatInstant('2026-03-29T01:30:00Z', 'en-GB', 'Europe/Berlin');

      expect(beforeDst).toContain('01:30:00'); // UTC+1 (CET)
      expect(afterDst).toContain('03:30:00'); // UTC+2 (CEST)
    });

    it('formats UTC instants accurately across Europe/Berlin autumn fallback DST change', () => {
      // 2026-10-25: Europe/Berlin falls back at 01:00 UTC (03:00 CEST -> 02:00 CET)
      const beforeFallback = formatInstant('2026-10-25T00:30:00Z', 'en-GB', 'Europe/Berlin');
      const afterFallback = formatInstant('2026-10-25T01:30:00Z', 'en-GB', 'Europe/Berlin');

      expect(beforeFallback).toContain('02:30:00'); // UTC+2 (CEST)
      expect(afterFallback).toContain('02:30:00'); // UTC+1 (CET)
    });
  });
});
