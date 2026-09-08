# Prospecting Beast v40

UX-first exact LinkedIn enrichment for Seamless Public API v1.

## Core workflow

1. Paste one LinkedIn person URL.
2. Beast checks Supabase first.
3. If the profile is new, Beast submits exactly one `POST /contacts/research` request containing exactly one `liProfileUrl` and keeps Seamless deduplication enabled.
4. Beast polls that single request until it finishes.
5. The result appears in the same viewport. Previous session results remain stacked in a vertical scroll-snap feed above it.

There is no contact-search fan-out, no MCP discovery step, and no confirmation modal.

## Multi-key policy

```text
SEAMLESS_API_KEY_PRIMARY   -> used first while fresh balance > 0
SEAMLESS_API_KEY_SECONDARY -> standby until PRIMARY is confirmed exhausted
```

No proxy or egress-IP configuration is required in v40. If PRIMARY returns an explicit `insufficientCredits` rejection, Beast can fail over once to the next configured organization. Timeouts and ambiguous network failures never cause an automatic second paid submission.

## Credit indicator

The displayed balance comes only from Seamless's `X-PublicAPI-Credits` response header on fresh authenticated v1 requests.

- Beast refreshes the provider balance every 10 seconds while the page is open.
- Opening the credit panel forces another fresh status read.
- Returning to the browser tab refreshes it again.
- Each organization has its own timestamp.
- The combined total is displayed only when **every configured organization** returned a fresh numeric credit header in that status cycle.
- A missing/failed fresh header produces `Credits unavailable`; Beast never substitutes an older cached number into the displayed total.

A provider header is authoritative for the moment that response was returned. Another user/process in the same Seamless organization can change the balance immediately afterwards, so the UI shows snapshot freshness rather than pretending it is a transactionally locked counter.

## Contact organization

The compact result card shows:

- Name
- Current company
- Current-company email/phone data when Seamless supplies that association
- Personal/direct email/phone data
- Other returned contact values whose company association is not confirmed
- Employment history in an optional drawer

Company switchboard numbers are retained and labeled as current-company data instead of being discarded. Historical job entries are never given a phone/email association unless Seamless actually provides one.

## Required Render environment variables

```text
APP_AUTH_TOKEN=...
SEAMLESS_API_KEY_PRIMARY=...
SEAMLESS_API_KEY_SECONDARY=...   # optional
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
```

Optional:

```text
SEAMLESS_API_BASE_URL=https://api.seamless.ai/api/client/v1
SEAMLESS_API_TIMEOUT_MS=30000
SEAMLESS_POLL_INTERVAL_MS=2500
```

## Deploy

```bash
npm ci
npm test
npm run build
npm start
```

Health endpoint:

```text
GET /health
```
