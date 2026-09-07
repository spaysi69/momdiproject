# Prospecting Beast v31 — Direct LinkedIn REST Enrichment

v31 replaces the broken LinkedIn-to-MCP-search architecture with the workflow Seamless officially documents for a known LinkedIn profile URL.

## What the app does

1. Paste a person's LinkedIn profile URL.
2. The server normalizes the URL and checks Supabase first. This lookup does not call Seamless research.
3. If a completed result exists, it is returned immediately with no new provider request.
4. If no result exists, the UI offers **Enrich contact** and requires confirmation.
5. On confirmation the backend sends `POST /contacts/research` with:

```json
{
  "contacts": [{ "liProfileUrl": "https://www.linkedin.com/in/example/" }],
  "skipDeduplicationCheck": false
}
```

6. The backend stores the returned `requestIds` and polls `GET /contacts/research/poll?requestIds=...` every 2.5 seconds while the UI is open.
7. Completed contact data is saved in Supabase and reused on future lookups.

MCP is not required by this workflow and is not used in v31.

## Why v31 is different

The previous build tried to use MCP `search_contacts` as a free lookup by LinkedIn profile URL. Seamless's published MCP search schema does not document a LinkedIn URL filter, while the REST Contact Research endpoint explicitly accepts `liProfileUrl`. v31 therefore goes directly from a known LinkedIn profile URL to REST research only after user confirmation.

The app also reads the authoritative remaining organization research balance from the `X-PublicAPI-Credits` header. It does not maintain a fake local credits counter. The status check uses a no-research organization contact read solely to obtain response headers.

## Render environment

```dotenv
APP_AUTH_TOKEN=your-workspace-password
SEAMLESS_API_KEY=your-public-api-v1-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-server-side-supabase-key
```

Existing deployments may keep `SEAMLESS_API_KEY_PRIMARY` instead of renaming it; v31 accepts it as a fallback. `SEAMLESS_MCP_API_KEY` is also accepted as a compatibility fallback only if that same connection has Public API v1 access. To explicitly select a variable:

```dotenv
SEAMLESS_KEY_SOURCE=SEAMLESS_API_KEY_PRIMARY
```

Optional overrides:

```dotenv
SEAMLESS_API_BASE_URL=https://api.seamless.ai/api/client/v1
SEAMLESS_API_TIMEOUT_MS=30000
```

No MCP URL/environment variable is needed.

## Supabase

Run `supabase/schema.sql` once if these tables are not already present. v31 reuses the v30 tables, so no new migration is required when upgrading from v30.

- `person_searches`: normalized LinkedIn profile URLs.
- `contact_research`: one deterministic research state per normalized LinkedIn URL.
- `enrichment_profiles`: retained for compatibility with older data.

The deterministic research key plus a unique database insert acts as an idempotency gate. Concurrent browser/server requests cannot intentionally submit the same profile twice. A completed result is always returned from Supabase first.

If a provider submission times out after the request may have reached Seamless, the app marks it for review and does not automatically retry. This is deliberate protection against accidental duplicate research.

## Local verification

Use Node.js 24:

```sh
npm ci
npm run build
npm test
node --env-file=.env dist/src/index.js
```

Open `http://localhost:3000` and enter `APP_AUTH_TOKEN`.

## Active routes

- `GET /health`
- `GET /ready`
- `GET /status`
- `POST /v1/person/lookup`
- `POST /v1/person/research`
- `POST /v1/person/research/status`

All workspace/data routes except `/health` require the workspace bearer token.

## Provider contract used

- Base URL: `https://api.seamless.ai/api/client/v1`
- API-key authentication: `Token: YOUR_API_KEY`
- Direct contact research: `contacts[].liProfileUrl`
- Research deduplication remains enabled (`skipDeduplicationCheck: false`)
- Polling uses returned `requestIds`
- Poll interval: 2.5 seconds
- Credits: `X-PublicAPI-Credits` response header

The automated tests use local mocks and verify this request shape, authentication header, polling, caching, and duplicate-submission guards. A live Seamless request is intentionally not run without your secret key.
