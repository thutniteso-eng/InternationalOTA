import { describe, expect, it } from 'vitest';
import { MESSAGE_CATALOGS, validateCatalogParity } from '../src/index.ts';

describe('AC5: Message catalog parity', () => {
  it('verifies vi.json and en.json have identical keys and identical ICU arguments', () => {
    const result = validateCatalogParity(MESSAGE_CATALOGS);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('detects a deliberately missing key across locales', () => {
    const broken = {
      en: { ...MESSAGE_CATALOGS['en']!, 'test.onlyInEn': 'Only in English' },
      vi: { ...MESSAGE_CATALOGS['vi']! },
    };
    const result = validateCatalogParity(broken);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Missing key "test.onlyInEn" in locale "vi"'),
    );
  });

  it('detects a deliberately mismatched ICU argument across locales', () => {
    const broken = {
      en: { ...MESSAGE_CATALOGS['en']!, 'common.greeting': 'Hello, {name}!' },
      vi: { ...MESSAGE_CATALOGS['vi']!, 'common.greeting': 'Xin chào, {username}!' },
    };
    const result = validateCatalogParity(broken);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('ICU argument mismatch for key "common.greeting"'),
    );
  });
});
