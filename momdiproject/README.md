# Enrichment Router v2

A production-oriented Node.js + TypeScript enrichment service built around a quota-aware scheduler, Redis-backed BullMQ queue, caching, request deduplication, typed provider responses, health/readiness endpoints, Prometheus metrics, secure secret injection, and dynamic provider credential discovery.

The router deliberately does **not** implement proxy rotation, User-Agent rotation, credential cycling, or other mechanisms intended to circumvent a provider's rate limits or access controls. Configure only credentials, quotas, network settings, and request volume you are authorized to use.

## Credential architecture

Provider credentials are no longer hardcoded as `PRIMARY`/`SECONDARY`. The application discovers any non-empty environment variable matching:

```text
SEAMLESS_API_KEY_<id>
```

Examples:

```text
SEAMLESS_API_KEY_01
SEAMLESS_API_KEY_02
SEAMLESS_API_KEY_03
...
SEAMLESS_API_KEY_50
```

Adding another authorized credential means adding the environment variable; no TypeScript or route-file change is required.

Optional per-credential metadata uses the same ID:

```text
SEAMLESS_ROUTE_01_RPM=60
SEAMLESS_ROUTE_01_RPD=10000
SEAMLESS_ROUTE_01_PRIORITY=100
SEAMLESS_ROUTE_01_ENABLED=true
SEAMLESS_ROUTE_01_EXPECTED_IP=203.0.113.10
SEAMLESS_ROUTE_01_NETWORK_LABEL=primary-egress
```

Defaults live in `routes.config.json` and apply to newly discovered credentials. The secret itself is only read from the environment and is never returned by the API/dashboard.

### IP / network visibility

Each credential can declare an expected egress IP for operational verification. After successful provider calls, the service asynchronously probes the configured egress-IP endpoint (default `https://api.ipify.org?format=json`) and records the observed IP in Redis. The admin dashboard shows:

```text
Expected IP
Observed IP
IP match: YES/NO
Last IP check
```

This is a monitoring/configuration feature. It does not rotate proxies or attempt to bypass provider controls.

## Architecture

```text
Browser / client
      |
      v
 Express API -- auth --> normalize --> cache/dedupe --> BullMQ
                                                        |
                                                        v
                                                   Worker pool
                                                        |
                                              atomic Redis quota
                                                        |
                                                        v
                                              credential scheduler
                                                        |
                                                        v
                                                Provider adapter
```

## Local development

1. Copy `.env.example` to `.env` and set tokens plus authorized provider credentials.
2. Start Redis: `docker compose up redis -d`.
3. Install dependencies: `npm install`.
4. Run the API: `npm run dev`.
5. Run the worker in a second terminal: `npm run worker`.
6. Open `http://localhost:3000`.

API example:

```http
POST /api/v1/enrich
Authorization: Bearer <APP_API_TOKEN>
Content-Type: application/json

{"linkedinUrl":"https://www.linkedin.com/in/example"}
```

A cache hit returns `200`. A new job returns `202` and a `jobId`; poll `GET /api/v1/jobs/:id`. The API token is required on all `/api/*` requests.

Admin status: `GET /admin/status` with `ADMIN_API_TOKEN`.
Health: `GET /health` and `GET /ready`.
Metrics: `GET /metrics` with the admin token.

## Admin dashboard

The root page contains an admin-only credential-health table. It never displays provider API keys. It shows discovered credential IDs, status, credential presence, expected/observed egress IP, IP match, RPM/RPD usage, priority, latency, and cooldown.

## Production / Render

The Blueprint declares `SEAMLESS_API_KEY_01` through `SEAMLESS_API_KEY_20` as convenient placeholders. The application itself is **not capped at 20**: additional `SEAMLESS_API_KEY_<id>` variables can be added to the Render service environment and are discovered automatically, subject to the provider's authorization and your plan.

The worker must receive the same credential environment variables as the API process, because it performs provider calls.

Before production traffic, run:

```bash
npm run typecheck
npm test
npm run build
```

For reproducible CI, add and commit a generated `package-lock.json` later; this bundle does not fabricate one. The supplied Render/Docker build uses `npm install` so a clean checkout without a lockfile still installs successfully.
