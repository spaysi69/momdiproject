/**
 * Normalizes a North-American phone number for display/storage.
 * Desired format: 0+1XXXXXXXXXX
 * (zero + country code + digits), with no spaces, dots, dashes or parentheses.
 */
export function normalizePhone(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  let raw = String(value).trim();
  if (!raw) return undefined;

  // Keep only digits and a leading plus while we determine the country code.
  const cleaned = raw.replace(/[^0-9+]/g, '');

  // Desired format may already be present with punctuation after 0+1.
  if (/^0\+1/i.test(cleaned)) {
    const tail = cleaned.slice(3).replace(/\D/g, '');
    if (tail) return `0+1${tail}`;
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits) return undefined;

  // US/Canada numbers: 10 local digits -> 0+1XXXXXXXXXX.
  // 11 digits beginning with 1 -> 0+1XXXXXXXXXX.
  if (digits.length === 10) return `0+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `0+${digits}`;

  // Equivalent +1 / 001 styles.
  if (raw.startsWith('+1') && digits.startsWith('1')) return `0+${digits}`;
  if (digits.startsWith('001') && digits.length === 12) return `0+${digits.slice(2)}`;

  // For non-North-American values, still remove punctuation and preserve a
  // leading international plus. We only add the user's requested 0+1 form
  // when the value is actually a +1/NANP number.
  if (raw.startsWith('+')) return `+${digits}`;
  return digits;
}

export function normalizePhoneList(values: unknown[]): string[] {
  return values
    .map(normalizePhone)
    .filter((v): v is string => Boolean(v));
}
