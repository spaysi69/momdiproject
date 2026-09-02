import { createHash } from 'node:crypto';

export function normalizeLinkedInUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported URL protocol');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'linkedin.com') throw new Error('URL must use linkedin.com');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts[0]?.toLowerCase() !== 'in') throw new Error('URL must be a LinkedIn profile URL');
  const slug = parts[1]!.toLowerCase();
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

export function cacheKey(normalizedUrl: string): string {
  const digest = createHash('sha256').update(normalizedUrl).digest('hex');
  return `enrichment:v1:${digest}`;
}
