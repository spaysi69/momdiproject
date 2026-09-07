# Prospecting Beast v36 — Exact LinkedIn, Single Research

v36 intentionally removes contact discovery from the enrichment workflow.

The user already knows the target person because they provide an exact LinkedIn profile URL. Beast therefore does not call Seamless contact-search endpoints and does not use MCP search.

## Normal workflow

1. Paste one LinkedIn person URL.
2. Optionally enter the company you care about.
3. Beast checks Supabase only. A completed cached result is returned with no Seamless research request.
4. If uncached, Beast shows the exact research plan and requires explicit confirmation.
5. Beast selects exactly one configured Seamless organization/egress route.
6. Beast submits exactly one contact object:

```json
{
  "contacts": [
    { "liProfileUrl": "https://www.linkedin.com/in/example/" }
  ],
  "skipDeduplicationCheck": false
}
```

7. Exactly one returned request ID is required for automatic continuation. Zero or multiple IDs are quarantined as `needs_review`.
8. Beast polls that one request ID on the same API key and egress route. Polling never triggers a second research submission.
9. The result shows current company/title, contact details, and returned employment history.
10. If a target company was entered, Beast labels it as CURRENT, FORMER, or NOT MATCHED. It never automatically spends another credit to chase a historical company.

## Credit safeguards

- No `/search/contacts` in the production runtime.
- No MCP `search_contacts` in the production runtime.
- One research click submits one `liProfileUrl` only.
- `skipDeduplicationCheck` is always `false`.
- Concurrent clicks are deduplicated through Supabase before provider submission.
- An ambiguous network failure is never automatically retried.
- No automatic failover to a second Seamless organization after a research submission.
- Beast records the organization balance immediately before research and the provider-reported balance after research/polling.
- A measured delta of 1 is shown as the expected debit; 0 can occur for provider deduplication; a delta greater than 1 is prominently flagged as an anomaly.

## Company semantics

A LinkedIn URL identifies the person. Seamless returns the current company/title it has for that person plus fields such as former company and `jobHistory` when available. The optional Target Company field is a post-enrichment verification guard; it is not silently added to the identity request because the documented exact LinkedIn identity is `liProfileUrl`.

If the target company appears only in job history, Beast warns that the returned email/phone are the contact data Seamless returned for the person/current role and does not claim they are historical-company contact details.

## Credits widget

The displayed organization balances come from the `X-PublicAPI-Credits` header on fresh authenticated Seamless responses. They are provider snapshots, not a locally decremented counter. With multiple independent organizations, Beast sums only fresh numeric balances.

## Render variables

```dotenv
APP_AUTH_TOKEN=your-workspace-password
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-server-side-supabase-key

SEAMLESS_API_KEY_PRIMARY=...
SEAMLESS_EGRESS_PROXY_PRIMARY=http://user:pass@proxy-a:port

SEAMLESS_API_KEY_SECONDARY=...
SEAMLESS_EGRESS_PROXY_SECONDARY=http://user:pass@proxy-b:port

SEAMLESS_REQUIRE_UNIQUE_EGRESS=true
SEAMLESS_EGRESS_CHECK_URL=https://api.ipify.org?format=json
SEAMLESS_API_BASE_URL=https://api.seamless.ai/api/client/v1
```

If you configure multiple organizations, each research job is pinned to the one route selected before submission. There is no automatic paid failover.

## Verification

```sh
npm ci --no-audit --no-fund
npm run build
npm test
```

The automated suite verifies the exact one-contact request payload, deduplication, double-click protection, timeout safety, one-request-ID invariant, company/current-history checks, credit-delta anomaly detection, multi-org route pinning, unique egress, fresh credit snapshots, HTTP auth, and absence of contact-search/MCP runtime code.
