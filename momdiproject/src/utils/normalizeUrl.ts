import crypto from 'node:crypto';

export function normalizeLinkedInUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'https:') throw new Error('LinkedIn URL must use HTTPS');
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'linkedin.com' && hostname !== 'www.linkedin.com') throw new Error('Invalid LinkedIn hostname');
  const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
  if (!match) throw new Error('Expected a LinkedIn profile URL');
  let slug: string;
  try { slug = decodeURIComponent(match[1]).trim(); } catch { throw new Error('Invalid LinkedIn profile slug'); }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)) throw new Error('Invalid LinkedIn profile slug');
  return `https://www.linkedin.com/in/${slug}/`;
}

export function cacheKey(normalizedUrl: string) {
  return `enrichment:v1:${crypto.createHash('sha256').update(normalizedUrl).digest('hex')}`;
}
