import { describe, expect, it } from 'vitest';
import { formatPlatformGreeting, type PlatformInfo } from './index.js';

describe('formatPlatformGreeting', () => {
  it('formats platform greeting text correctly', () => {
    const info: PlatformInfo = {
      name: 'InternationalOTA',
      tagline: 'Vietnam-first independent travel platform',
    };
    expect(formatPlatformGreeting(info)).toBe(
      'DELIBERATE CI FAILURE — Vietnam-first independent travel platform',
    );
  });
});
