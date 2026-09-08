# Prospecting Beast v41 Deep Diagnostic Test

This build exists to observe the Seamless integration in detail before making further production changes.

## What it records

Without adding extra Seamless research requests, the diagnostic session records:

- Every Seamless HTTP request already made by Beast, with a unique call ID.
- Method, path, redacted request headers, exact JSON request payload, HTTP status, response headers and raw response body.
- Every `X-PublicAPI-Credits` observation, route/key source, timestamp, rate-limit headers and balance change.
- Every credit-indicator refresh and its cause: workspace load, credit click, connection click, tab resume, pre-enrichment selection, research response, polling and final reconciliation.
- PRIMARY/SECONDARY route-selection decisions, candidates skipped, explicit exhaustion, and safe failover events.
- Cache lookup, research-lock/claim decisions and stored job state transitions.
- The single research submission, number of contacts submitted, request IDs and all poll states.
- Parsed contact summary alongside the full raw Seamless contact object.
- Browser/UI events: what total was displayed, what route was shown active, slide creation, rendered result status and credit delta shown to the user.
- Derived invariants and counts: provider HTTP calls, research POSTs, submitted contacts, polls, balance reads, request IDs, credit jumps, deduplication setting and search/MCP absence.

Secrets such as API keys, authorization headers, passwords and tokens are redacted. Contact data is intentionally preserved because this is a debugging build.

## How to use it

1. Deploy this test build with the same Render environment as the production build.
2. Open the workspace. It automatically starts a new diagnostic session and captures the initial balance probes.
3. Prefer a LinkedIn URL that is not already cached if you want to observe a new paid research operation.
4. Click **Enrich** once.
5. Wait until the result finishes.
6. Click **Diagnostics** in the top bar.
7. Click **Copy FULL report** or **Download JSON**.
8. Send the report back to ChatGPT for analysis.

The **Reset trace + baseline** button clears only the in-memory diagnostic journal, then performs a normal balance/status baseline read. It does not trigger contact research.

## Safety model

- Normal enrichment uses one `POST /contacts/research` containing one `liProfileUrl`.
- `skipDeduplicationCheck` remains `false`.
- No contact-search fan-out.
- No MCP discovery.
- No automatic retry after an ambiguous submission outcome.
- SECONDARY is used only after PRIMARY is confirmed exhausted or PRIMARY returns explicit `insufficientCredits`.
- Diagnostics add application-server telemetry requests only; they do not add Seamless research requests.

## Required environment

```text
APP_AUTH_TOKEN=...
SEAMLESS_API_KEY_PRIMARY=...
SEAMLESS_API_KEY_SECONDARY=...   # optional
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
```

No proxy/egress variables are required.
