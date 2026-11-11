import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LICENSES,
  checkLicenses,
  isLicenseAllowed,
  isWithAllowed,
  loadExceptions,
  run,
} from './check-licenses.mjs';

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
      expect(isLicenseAllowed('   ')).toBe(false);
      // @ts-expect-error testing null input
      expect(isLicenseAllowed(null)).toBe(false);
      // @ts-expect-error testing undefined input
      expect(isLicenseAllowed(undefined)).toBe(false);
    });

    it('correctly handles operator precedence and grouping (C1)', () => {
      // AND binds tighter than OR, parentheses respected
      expect(isLicenseAllowed('GPL-3.0 AND (MIT OR Apache-2.0)')).toBe(false);
      expect(isLicenseAllowed('MIT OR (GPL-3.0 AND BSD-3-Clause)')).toBe(true);
      expect(isLicenseAllowed('(MIT OR GPL-3.0)')).toBe(true);
      expect(isLicenseAllowed('Apache-2.0 OR Proprietary')).toBe(true);
      expect(isLicenseAllowed('BSD-3-Clause OR CC-BY-NC-4.0')).toBe(true);
      expect(isLicenseAllowed('(0BSD OR CC0-1.0)')).toBe(true);
      expect(isLicenseAllowed('GPL-2.0 OR GPL-3.0')).toBe(false);
      expect(isLicenseAllowed('Proprietary OR Commercial')).toBe(false);
      expect(isLicenseAllowed('Apache-2.0 AND MIT')).toBe(true);
      expect(isLicenseAllowed('MIT AND GPL-3.0')).toBe(false);
    });

    it('handles nested parentheses correctly', () => {
      expect(isLicenseAllowed('((MIT OR Apache-2.0) AND BSD-3-Clause)')).toBe(true);
      expect(isLicenseAllowed('((GPL-3.0 OR Apache-2.0) AND (MIT AND GPL-3.0))')).toBe(false);
      expect(isLicenseAllowed('(((MIT)))')).toBe(true);
      expect(isLicenseAllowed('((MIT OR (Apache-2.0 AND BSD-3-Clause)))')).toBe(true);
    });

    it('handles WITH clause per specification', () => {
      // Not allowed unless base is allowed AND pair is explicitly listed
      expect(isLicenseAllowed('Apache-2.0 WITH LLVM-exception')).toBe(false);
      expect(isLicenseAllowed('GPL-3.0 WITH Classpath-exception-2.0')).toBe(false);

      const customWithPairs = new Set(['Apache-2.0 WITH LLVM-exception']);
      expect(
        isLicenseAllowed('Apache-2.0 WITH LLVM-exception', ALLOWED_LICENSES, customWithPairs),
      ).toBe(true);

      // Base license not allowed even if pair was somehow listed
      const unallowedBasePairs = new Set(['GPL-3.0 WITH Custom-exception']);
      expect(
        isLicenseAllowed('GPL-3.0 WITH Custom-exception', ALLOWED_LICENSES, unallowedBasePairs),
      ).toBe(false);

      expect(isWithAllowed('Apache-2.0', 'LLVM-exception', ALLOWED_LICENSES, customWithPairs)).toBe(
        true,
      );
      expect(isWithAllowed('GPL-3.0', 'LLVM-exception', ALLOWED_LICENSES, customWithPairs)).toBe(
        false,
      );
    });

    it('rejects malformed inputs and syntax errors safely', () => {
      expect(isLicenseAllowed('MIT OR')).toBe(false);
      expect(isLicenseAllowed('AND MIT')).toBe(false);
      expect(isLicenseAllowed('(MIT')).toBe(false);
      expect(isLicenseAllowed('MIT)')).toBe(false);
      expect(isLicenseAllowed('()')).toBe(false);
      expect(isLicenseAllowed('(   )')).toBe(false);
      expect(isLicenseAllowed('MIT AND AND Apache-2.0')).toBe(false);
      expect(isLicenseAllowed('MIT WITH')).toBe(false);
      expect(isLicenseAllowed('WITH LLVM-exception')).toBe(false);
      expect(isLicenseAllowed('MIT @@@ Apache-2.0')).toBe(false);
    });
  });

  describe('checkLicenses with packages and exceptions (C2)', () => {
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

    it('allows an unallowed package when exception matches exact license and has reason', () => {
      const mockData = {
        'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.0'] }],
      };
      const exceptions = {
        'caniuse-lite': {
          license: 'CC-BY-4.0',
          reason: 'Data license approved for Next.js transitive dependency',
        },
      };
      const result = checkLicenses(mockData, exceptions);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('rejects an exception when observed license mismatches the exception license (C2)', () => {
      // caniuse-lite re-licensed to GPL-3.0 must NOT pass with a CC-BY-4.0 exception
      const mockData = {
        'GPL-3.0': [{ name: 'caniuse-lite', versions: ['2.0.0'] }],
      };
      const exceptions = {
        'caniuse-lite': {
          license: 'CC-BY-4.0',
          reason: 'Approved for CC-BY-4.0 only',
        },
      };
      const result = checkLicenses(mockData, exceptions);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('caniuse-lite');
    });

    it('rejects an exception entry missing reason or license', () => {
      const mockData = {
        'GPL-3.0': [{ name: 'bad-pkg-1', versions: ['1.0.0'] }],
        'AGPL-3.0': [{ name: 'bad-pkg-2', versions: ['2.0.0'] }],
      };
      const exceptions = {
        'bad-pkg-1': { license: 'GPL-3.0' } as { license: string; reason: string },
        'bad-pkg-2': { license: 'AGPL-3.0', reason: '   ' },
      };
      const result = checkLicenses(mockData, exceptions);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(2);
    });
  });

  describe('loadExceptions (C3)', () => {
    it('returns empty object when file does not exist', () => {
      expect(loadExceptions('/non/existent/file.json')).toEqual({});
    });

    it('throws when file has invalid JSON', () => {
      // Mock with a path that will fail JSON parse
      expect(() => {
        loadExceptions('README.md');
      }).toThrowError(/Invalid JSON/);
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

    it('returns false and logs error when exceptions file is invalid (C3)', () => {
      const success = run({
        licensesData: {},
        exceptionsPath: 'README.md', // not valid JSON
      });
      expect(success).toBe(false);
    });
  });
});
