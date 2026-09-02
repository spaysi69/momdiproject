# Changelog

## 2.1.0

- Replaced hardcoded `PRIMARY`/`SECONDARY` route configuration with automatic `SEAMLESS_API_KEY_<id>` discovery.
- Added per-credential RPM/RPD/priority/enabled/expected-IP/network-label overrides through environment variables.
- Added observed egress-IP monitoring with asynchronous cached probing and admin visibility.
- Added per-credential usage, cooldown, latency, credential-presence, and IP-match status to the admin endpoint/dashboard.
- Preserved legacy `SEAMLESS_API_KEY_PRIMARY` / `SEAMLESS_API_KEY_SECONDARY` compatibility when numbered credentials are not configured.
- Added configuration discovery tests.

## 2.0.0

- Replaced route/key/proxy rotation with a quota-aware scheduler that operates only within configured authorized capacity.
- Removed anti-detection behavior and proxy-per-route architecture.
- Added atomic Redis quota reservations using Lua.
- Added Redis-backed persistent route state and explicit states for authentication failure and exhausted credits.
- Added BullMQ for durable distributed jobs, concurrency, delayed retry support, and stalled-job recovery.
- Added URL normalization, cache, and concurrent-request deduplication.
- Added API authentication, Redis-backed request rate limiting, Helmet, JSON payload limits, request IDs, health/readiness endpoints, and protected metrics.
- Added typed provider adapter and provider response validation.
- Added route reset endpoint for operator recovery after credential/quota remediation.
- Upgraded deployment baseline to Node 24 and current Render Blueprint terminology.
