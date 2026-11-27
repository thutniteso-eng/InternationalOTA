import { randomInt } from 'node:crypto';

// Crockford Base32 alphabet (excludes I, L, O, U)
export const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const BOOKING_REFERENCE_PREFIX = 'PQ-';
export const BOOKING_REFERENCE_REGEX = /^PQ-[0-9A-HJKMNP-TV-Z]{8}$/;

export function generateBookingReference(): string {
  let code = BOOKING_REFERENCE_PREFIX;
  for (let i = 0; i < 8; i++) {
    code += CROCKFORD_BASE32_ALPHABET[randomInt(0, CROCKFORD_BASE32_ALPHABET.length)]!;
  }
  return code;
}

export function normalizeBookingReference(raw: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  return BOOKING_REFERENCE_REGEX.test(normalized) ? normalized : null;
}
