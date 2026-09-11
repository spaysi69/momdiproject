# Prospecting Beast v45 — Persistent LinkedIn Session & Safety Controls

v45 builds on v44 without changing the Seamless enrichment architecture.

## LinkedIn Direct reliability changes

- Chromium now uses one persistent `--user-data-dir` rather than a new temporary profile for every prospecting job.
- The same browser/CDP session is reused across jobs while the server instance is alive.
- `LINKEDIN_PROFILE_DIR` can point to a Render Persistent Disk to retain browser state across service restarts.
- LinkedIn Direct jobs remain serialized through one collector queue.
- Request budgets are per prospecting job; the v44 lifetime-counter starvation edge case is fixed.
- A conservative global rate controller persists across jobs:
  - minimum delay between LinkedIn requests,
  - per-minute request ceiling,
  - per-hour request ceiling,
  - adaptive penalty after 429/5xx responses.
- A persistent circuit breaker stops LinkedIn Direct after:
  - HTTP 429,
  - HTTP 999/checkpoint,
  - login/authentication challenge,
  - repeated 5xx errors.
- The circuit exposes `CLOSED`, `OPEN`, and `HALF_OPEN` state without exposing cookies.
- Public OSINT collectors continue independently when LinkedIn Direct is unavailable/open-circuit.
- The Prospecting UI surfaces LinkedIn Direct circuit and request-rate status.

## Explicit non-goals

v45 does not implement fingerprint spoofing, CAPTCHA/checkpoint bypass, residential/proxy rotation, fake human interaction, or other mechanisms intended to defeat LinkedIn anti-abuse controls.
