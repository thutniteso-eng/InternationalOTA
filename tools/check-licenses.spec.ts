import { describe, expect, it } from 'vitest';
import { ALLOWED_LICENSES, checkLicenses, isLicenseAllowed, run } from './check-licenses.mjs';

describe('check-licenses', () => {
  describe('isLicenseAllowed', () => {
    it('accepts all canonical allowed licenses', () => {
      for (const lic of ALLOWED_LICENSES) {
        expect(isLicenseAllowed(lic)).toBe(true);
      }
    });

    it('rejects unallowed standalone licenses', () => {
      expect(isLicenseAllowed('GPL-3.0')).toBe(false);
      expect(isLicenseAllowed('AGPL-3.0')).toBe(false);
      expect(isLicenseAllowed('SSPL-1.0')).toBe(false);
      expect(isLicenseAllowed('Proprietary')).toBe(false);
      expect(isLicenseAllowed('UNKNOWN')).toBe(false);
      expect(isLicenseAllowed('')).toBe(false);
      // @ts-expect-error testing null input
      expect(isLicenseAllowed(null)).toBe(false);
    });

    it('accepts OR expressions containing at least one allowed license', () => {
      expect(isLicenseAllowed('(MIT OR GPL-3.0)')).toBe(true);
      expect(isLicenseAllowed('Apache-2.0 OR Proprietary')).toBe(true);
      expect(isLicenseAllowed('BSD-3-Clause OR CC-BY-NC-4.0')).toBe(true);
      expect(isLicenseAllowed('(0BSD OR CC0-1.0)')).toBe(true);
    });

    it('rejects OR expressions where no license is allowed', () => {
      expect(isLicenseAllowed('GPL-2.0 OR GPL-3.0')).toBe(false);
      expect(isLicenseAllowed('Proprietary OR Commercial')).toBe(false);
    });

    it('handles AND expressions properly', () => {
      expect(isLicenseAllowed('Apache-2.0 AND MIT')).toBe(true);
      expect(isLicenseAllowed('MIT AND GPL-3.0')).toBe(false);
    });
  });

  describe('checkLicenses with packages and exceptions', () => {
    it('passes when all packages have allowed licenses', () => {
      const mockData = {
        MIT: [{ name: 'allowed-pkg-1', versions: ['1.0.0'] }],
        'Apache-2.0': [{ name: 'allowed-pkg-2', versions: ['2.1.0'] }],
      };
      const result = checkLicenses(mockData, {});
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.totalPackages).toBe(2);
    });

    it('reports violations for packages with unallowed licenses', () => {
      const mockData = {
        'GPL-3.0': [{ name: 'bad-pkg', versions: ['0.9.0'] }],
      };
      const result = checkLicenses(mockData, {});
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        {
          name: 'bad-pkg',
          versions: '0.9.0',
          license: 'GPL-3.0',
        },
      ]);
    });

    it('allows an unallowed package if listed in exceptions with a reason', () => {
      const mockData = {
        'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.0'] }],
      };
      const exceptions = {
        'caniuse-lite': {
          reason: 'Browser compatibility database bundled by Next.js',
        },
      };
      const result = checkLicenses(mockData, exceptions);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('rejects an exception entry missing a reason field or with empty reason', () => {
      const mockData = {
        'GPL-3.0': [{ name: 'bad-pkg-1', versions: ['1.0.0'] }],
        'AGPL-3.0': [{ name: 'bad-pkg-2', versions: ['2.0.0'] }],
      };
      const exceptions = {
        'bad-pkg-1': {} as { reason: string },
        'bad-pkg-2': { reason: '   ' },
      };
      const result = checkLicenses(mockData, exceptions);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(2);
    });
  });

  describe('run function', () => {
    it('returns true when simulated licenses and exceptions are valid', () => {
      const mockData = {
        MIT: [{ name: 'test-pkg', versions: ['1.0.0'] }],
      };
      const success = run({
        licensesData: mockData,
        exceptionsPath: '/non/existent/path',
      });
      expect(success).toBe(true);
    });

    it('returns false when simulated licenses have unexempted violations', () => {
      const mockData = {
        'GPL-3.0': [{ name: 'unexempted-pkg', versions: ['1.0.0'] }],
      };
      const success = run({
        licensesData: mockData,
        exceptionsPath: '/non/existent/path',
      });
      expect(success).toBe(false);
    });
  });
});
