import { describe, expect, it } from 'vitest';
import { formatPlatformGreeting } from '@internationalota/shared';

describe('HomePage workspace integration', () => {
  it('formats shared greeting properly', () => {
    const message = formatPlatformGreeting({
      name: 'InternationalOTA',
      tagline: 'Testing shared link',
    });
    expect(message).toBe('InternationalOTA — Testing shared link');
  });
});
