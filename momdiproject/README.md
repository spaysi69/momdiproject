# Prospecting Beast v48 — Premium Experience

Prospecting Beast now has two independent workspaces:

- **Enriching** — the exact LinkedIn → Seamless flow preserved from v42.
- **Prospecting** — company name + Flagged/Not Flagged role families → maximum-recall employee discovery.

The Prospecting workspace never calls Seamless research and cannot spend Seamless credits.

## What changed in v48

v48 keeps the v47 Multi-Path Discovery backend intact and upgrades both workspaces with a premium visual system, richer motion/micro-interactions, cleaner prospect result cards, and a provider-neutral token balance drawer.

The credits drawer now exposes only Primary token / Secondary token terminology; API-key names and provider branding are not shown there.

## What changed in v47

v47 fixes the false-zero discovery failure seen with company/role searches such as Intel + Cybersecurity Manager. Public search no longer treats a zero-result compound query as exhausted: it recursively decomposes title bundles down to single-title dorks and retries looser forms.

LinkedIn Direct is now multi-path: company resolution can use the authenticated Companies UI, organization universal-name endpoint, slug candidates, or GraphQL; employee search can use multiple Voyager query shapes/IDs and falls back to LinkedIn's authenticated server-rendered People search when structured search returns zero.

The UI no longer shows `circuit CLOSED` as if it were proof that LinkedIn Direct succeeded. CLOSED only means the protection breaker has not tripped; it is surfaced only when relevant.

## LinkedIn Direct foundation

v44 introduced the authenticated **LinkedIn Direct** collector and adaptive query partitioning on top of the v43 public OSINT engine.

### LinkedIn Direct

When `LINKEDIN_LI_AT` and `LINKEDIN_JSESSIONID` are configured, Beast:

1. starts a headless Chromium session inside the production container;
2. injects the authenticated LinkedIn cookies server-side;
3. resolves the entered company through LinkedIn search;
4. queries LinkedIn's structured Voyager people search with a `currentCompany` filter;
5. searches the selected role aliases;
6. paginates each bucket;
7. merges results with the public OSINT sources by canonical LinkedIn profile URL.

No LinkedIn cookies are sent to the browser UI or returned by the capabilities endpoint.

If Chromium cannot be started in `auto` mode, Beast can fall back to authenticated HTTP. If LinkedIn returns a checkpoint, login redirect, 999, or rate limit, the direct collector halts instead of trying to bypass the challenge; public OSINT can still finish the job.

### Adaptive partitioning

The planner now has two saturation strategies:

- **Public search saturation:** when an OSINT engine fills the configured result limit for a multi-alias query, Beast recursively splits the alias bundle and searches smaller buckets.
- **LinkedIn Direct saturation:** when a company+role bucket is large, Beast partitions it by LinkedIn network depth (`F`, `S`, `O`) before paginating each partition.

Alias scheduling is round-robin across selected roles so a large first role family cannot consume the direct-search budget before later roles get coverage.

## Prospecting workflow

1. Open **Prospecting**.
2. Enter a company name — a LinkedIn company URL is not required.
3. Choose **Flagged** or **Not Flagged**.
4. Select all role families or specific role families.
5. Click **Find employees**.
6. Results appear while public OSINT and LinkedIn Direct run.

The UI exposes:

- unique employees found;
- high-confidence/current counts;
- how many final employees came from LinkedIn Direct;
- direct collector state, request count, and adaptive partition count;
- role confidence, current-employment confidence, source provenance, filtering, and CSV export.

## LinkedIn Direct configuration

Add the following server-side environment variables in Render:

```env
LINKEDIN_DIRECT_ENABLED=true
LINKEDIN_LI_AT=<your authenticated li_at cookie>
LINKEDIN_JSESSIONID=<your authenticated JSESSIONID cookie>
LINKEDIN_DIRECT_TRANSPORT=auto
```

`LINKEDIN_JSESSIONID` may be entered as the raw numeric/base value or as `ajax:<value>`; Beast normalizes it internally.

Recommended defaults:

```env
LINKEDIN_DIRECT_PAGE_SIZE=25
LINKEDIN_DIRECT_PARTITION_AT=400
LINKEDIN_DIRECT_BUCKET_CAP=900
LINKEDIN_DIRECT_MAX_REQUESTS=120
LINKEDIN_DIRECT_ALIASES_PER_ROLE=24
LINKEDIN_DIRECT_DELAY_MS=0
LINKEDIN_UI_MAX_PAGES=20
PROSPECT_ADAPTIVE_SPLIT_DEPTH=5
PROSPECT_MAX_ENGINE_CALLS=600
```

`LINKEDIN_SEARCH_QUERY_ID` is optional and exists so a new Voyager search query ID can be supplied without changing source code.

## Public OSINT sources

v43's free collectors remain available:

- Bing RSS with HTML fallback
- DuckDuckGo HTML with Lite fallback
- Yahoo HTML search
- optional self-hosted SearXNG

For stronger public-web coverage configure:

```env
SEARXNG_BASE_URL=https://your-searxng.example
```

## Build

```bash
npm test
npm run build
npm start
```

The supplied Dockerfile installs Chromium in the runtime image automatically for LinkedIn Direct.

## v45 LinkedIn Direct persistent session

The LinkedIn Direct collector now reuses one authenticated Chromium profile/session across prospecting jobs and serializes all LinkedIn work through one queue. It includes conservative request pacing and a circuit breaker that stops automatic LinkedIn Direct calls after rate-limit, checkpoint, login challenge, or repeated provider 5xx signals.

Required LinkedIn Direct environment variables remain:

```env
LINKEDIN_DIRECT_ENABLED=true
LINKEDIN_LI_AT=...
LINKEDIN_JSESSIONID=...
LINKEDIN_DIRECT_TRANSPORT=auto
```

Recommended reliability variables:

```env
LINKEDIN_PROFILE_DIR=/tmp/prospecting-beast-linkedin-profile
LINKEDIN_RATE_MIN_DELAY_MS=1200
LINKEDIN_RATE_MAX_PER_MINUTE=20
LINKEDIN_RATE_MAX_PER_HOUR=240
LINKEDIN_CIRCUIT_RATE_LIMIT_COOLDOWN_MS=900000
LINKEDIN_CIRCUIT_AUTH_COOLDOWN_MS=1800000
LINKEDIN_CIRCUIT_TRANSIENT_THRESHOLD=3
LINKEDIN_CIRCUIT_TRANSIENT_COOLDOWN_MS=120000
```

For profile persistence across Render service restarts, attach a Render Persistent Disk and set `LINKEDIN_PROFILE_DIR` to a directory on that mounted disk. Without a persistent disk, the profile still persists across prospecting jobs for the lifetime of the running service instance.

v45 intentionally does not implement CAPTCHA/checkpoint bypass, browser-fingerprint spoofing, proxy rotation, fake human interaction, or other anti-abuse-evasion mechanisms.
