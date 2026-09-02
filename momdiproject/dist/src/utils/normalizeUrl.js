"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLinkedInUrl = normalizeLinkedInUrl;
exports.cacheKey = cacheKey;
const node_crypto_1 = __importDefault(require("node:crypto"));
function normalizeLinkedInUrl(input) {
    let url;
    try {
        url = new URL(input.trim());
    }
    catch {
        throw new Error('Invalid URL');
    }
    if (url.protocol !== 'https:')
        throw new Error('LinkedIn URL must use HTTPS');
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'linkedin.com' && hostname !== 'www.linkedin.com')
        throw new Error('Invalid LinkedIn hostname');
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (!match)
        throw new Error('Expected a LinkedIn profile URL');
    let slug;
    try {
        slug = decodeURIComponent(match[1]).trim();
    }
    catch {
        throw new Error('Invalid LinkedIn profile slug');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug))
        throw new Error('Invalid LinkedIn profile slug');
    return `https://www.linkedin.com/in/${slug}/`;
}
function cacheKey(normalizedUrl) {
    return `enrichment:v1:${node_crypto_1.default.createHash('sha256').update(normalizedUrl).digest('hex')}`;
}
