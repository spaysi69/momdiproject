# Enrichment Service

Production-oriented Node.js/TypeScript service for authorized LinkedIn enrichment.

## Architecture

Browser UI → authenticated Express API → Supabase durable profile cache → Redis fast cache/quota state → authorized provider API.

The application always checks Supabase first. A previously enriched normalized LinkedIn URL is returned from the database and does **not** consume a provider request. Redis is used as a secondary fast cache and for quota/duplicate-request coordination.

## Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor** and run `supabase/schema.sql`.
3. From **Project Settings → API**, copy the project URL and the server-only **secret key**. Keep the service role key server-side only.
4. Add these Render environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

The table has a unique `normalized_url`, so repeated requests for the same canonical profile reuse the saved record.

## Render environment variables

- `REDIS_URL` — supplied by the Render Key Value connection.
- `APP_AUTH_TOKEN` — a private token you create for your own API.
- `SEAMLESS_API_KEY_PRIMARY` — your authorized provider API key.
- `SUPABASE_URL` — your Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — server-only Supabase service-role key.
- `PROVIDER_BASE_URL` — your authorized provider base URL.

Open `/` in a browser; the app will prompt for `APP_AUTH_TOKEN` immediately. The token is stored only in that browser's local storage.

## Caching flow

1. Normalize LinkedIn URL.
2. Query Supabase by `normalized_url`.
3. If found, return saved profile; provider quota is untouched.
4. Otherwise check Redis.
5. Acquire a short-lived Redis lock to avoid concurrent duplicate provider requests.
6. Reserve provider quota atomically.
7. Call provider.
8. Save the successful profile to Supabase first, then Redis.

## Important

This service must be used only within the provider's authorized limits and terms. It does not rotate credentials or proxies to circumvent provider restrictions.
