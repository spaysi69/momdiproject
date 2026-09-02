# Enrichment Service 2.1

Production-oriented TypeScript/Express service with Redis-backed atomic quota reservation, caching, authentication, readiness checks, structured logs, typed provider responses, and bounded retries.

This package intentionally does **not** rotate API keys, proxies, IPs, or User-Agent strings to circumvent provider limits. Configure only credentials and quotas you are authorized to use.

## Configuration

Set `APP_AUTH_TOKEN`, `REDIS_URL`, `SEAMLESS_API_KEY_PRIMARY`, and (for non-local deployments) `PROVIDER_BASE_URL` as environment variables. Keep real secrets out of Git.

`config.json` contains non-secret provider metadata and authorized quota settings.

## Local test

1. Start Redis on `localhost:6379`.
2. Set the required environment variables.
3. Run `npm install`.
4. Run `npm run build`.
5. Run `npm test`.
6. Run `npm run dev`.

For the fake provider, run `npm run mock:api` and set `PROVIDER_BASE_URL=http://localhost:4000`. In Render, set `PROVIDER_BASE_URL` to the exact base URL from the current Seamless developer documentation; this is intentionally not hardcoded because the documented endpoint can change.

## API

`GET /health` is public liveness.
`GET /ready` is public readiness and checks Redis.
`GET /status` requires `Authorization: Bearer <APP_AUTH_TOKEN>`.
`POST /v1/enrich` requires the same header and accepts `{ "linkedinUrl": "https://www.linkedin.com/in/example/" }`.

## Render

Deploy from `render.yaml`. Set `APP_AUTH_TOKEN` and `SEAMLESS_API_KEY_PRIMARY` in the Render dashboard. Use a persistent paid Key Value/Redis option for production state; do not rely on an ephemeral free instance for critical quota accounting.
