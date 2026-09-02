# Enrichment Service

Production-oriented Node.js/TypeScript service for an authorized Seamless.AI Public API integration.

## What changed

The provider adapter now follows Seamless's current documented contact-research workflow. For a LinkedIn profile URL, the service uses the direct **contact research** path instead of the old fictional `/v1/enrich` endpoint:

1. Normalize the LinkedIn profile URL.
2. Look up the URL in Supabase.
3. Look it up in Redis.
4. Acquire a short-lived Redis lock to avoid duplicate concurrent provider requests.
5. Atomically reserve local quota.
6. `POST https://api.seamless.ai/api/client/v1/contacts/research` with:
   `{"contacts":[{"liProfileUrl":"..."}],"skipDeduplicationCheck":false}`
7. Receive a `requestId` from the HTTP 202 response.
8. Poll `GET /contacts/research/poll?requestIds=<requestId>` until the status is `done` or `duplicate`.
9. Save the normalized result to Supabase and Redis.
10. Return the result to the UI.

Seamless documents API-key authentication with the `Token` header, direct contact research with `liProfileUrl`, HTTP 202 research submission, and polling by `requestId`. See the links in the documentation references below.

## Environment variables

Set these on Render (or your equivalent secret store):

- `REDIS_URL` — Render Key Value internal connection URL.
- `APP_AUTH_TOKEN` — private token for your own API.
- `SEAMLESS_API_KEY_PRIMARY` — authorized Seamless Public API key with the required scope/license.
- `SUPABASE_URL` — Supabase project URL.
- `SUPABASE_SECRET_KEY` — server-only Supabase secret key. Legacy `SUPABASE_SERVICE_ROLE_KEY` is accepted as a fallback.

No provider URL needs to be configured for production. The app uses the official production base URL by default:
`https://api.seamless.ai/api/client/v1`. `PROVIDER_BASE_URL` remains an optional override for an approved test environment only.

## Supabase

Run `supabase/schema.sql` once in Supabase SQL Editor. The `normalized_url` column is unique, so repeat submissions for the same canonical LinkedIn profile reuse the stored record instead of calling Seamless again.

## API

- `GET /` — web UI.
- `GET /health` — liveness check.
- `GET /ready` — Redis + Supabase readiness check.
- `GET /status` — authenticated route/quota status.
- `POST /v1/enrich` — authenticated JSON body `{ "linkedinUrl": "https://www.linkedin.com/in/example" }`.

## Important provider behavior

The app uses one authorized provider credential and respects the configured request budget. Provider credits are tracked server-side from the configured starting balance and decremented once when research is successfully submitted. Set `credits.starting` to the real current provider credit balance when first deploying this version. Seamless currently documents a standard API rate limit of 60 requests/minute and explains that research consumes credits; duplicate research can be avoided with deduplication. Confirm the exact limits and permissions attached to your own account before setting the local quota.

## Local development

```bash
npm install
npm run build
npm test
npm start
```

For a local provider mock, set `PROVIDER_BASE_URL=http://localhost:4000` and run the mock server.

## Deployment

The Render Blueprint expects the web service and Key Value service to be in the same Render region. Do not commit `.env`, provider API keys, or Supabase secrets.

## Documentation references

- https://docs.seamless.ai/authenticate-and-make-your-first-request
- https://docs.seamless.ai/research-without-search
- https://docs.seamless.ai/researchcontacts
- https://docs.seamless.ai/pollcontactsresearchresults

## UI session behavior
The web UI keeps the access code only in page memory. Reloading the page or opening a new tab requires signing in again.

## Results history
Each completed enrichment is added to the top of the results feed with a smooth entrance animation. Earlier results remain below in a scrollable history.
