import { describe, expect, it } from 'vitest';
import { normalizeLinkedInUrl } from '../src/utils/normalizeUrl.js';

describe('normalizeLinkedInUrl', () => {
  it('normalizes profile URL and strips tracking/query', () => {
    expect(normalizeLinkedInUrl('https://linkedin.com/in/Alice/?trk=abc')).toBe('https://www.linkedin.com/in/alice');
  });
  it('rejects non-profile URLs', () => {
    expect(() => normalizeLinkedInUrl('https://linkedin.com/company/acme')).toThrow();
  });
});
