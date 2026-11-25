import { t } from '@internationalota/i18n';
import { describe, expect, it } from 'vitest';
import { buildHreflangAlternates, isSupportedWebLocale, resolveWebLocale } from '../i18n/config';

describe('Web i18n routing & metadata (P1-11)', () => {
  it('AC6: resolves Accept-Language header via shared negotiateLocale', () => {
    expect(resolveWebLocale('en')).toBe('en');
    expect(resolveWebLocale('en-GB,en;q=0.9')).toBe('en');
    expect(resolveWebLocale('vi-VN,vi;q=0.9,en;q=0.8')).toBe('vi');
    expect(resolveWebLocale('fr-FR')).toBe('vi');
    expect(resolveWebLocale('ko')).toBe('vi');
    expect(resolveWebLocale(null)).toBe('vi');
  });

  it('validates supported web locales', () => {
    expect(isSupportedWebLocale('vi')).toBe(true);
    expect(isSupportedWebLocale('en')).toBe(true);
    expect(isSupportedWebLocale('ko')).toBe(false);
    expect(isSupportedWebLocale('fr')).toBe(false);
  });

  it('AC6: builds hreflang alternates including vi, en, and x-default', () => {
    const alternates = buildHreflangAlternates('vi');
    expect(alternates.canonical).toBe('/vi');
    expect(alternates.languages).toEqual({
      vi: '/vi',
      en: '/en',
      'x-default': '/vi',
    });
  });

  it('reads page copy from shared @internationalota/i18n catalogs', () => {
    expect(t('vi', 'common.tagline')).toBe('Nền tảng du lịch độc lập hiện đại');
    expect(t('en', 'common.tagline')).toBe('Modern Independent Travel Platform');
  });
});
