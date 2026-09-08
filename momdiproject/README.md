# Prospecting Beast v37 — One-Click Exact LinkedIn Enrichment

v37 is optimized for one task: paste an exact LinkedIn person URL, click **Enrich contact**, and receive an organized contact card without a broad search step.

## Provider workflow

1. Normalize the exact LinkedIn `/in/...` URL.
2. Check Supabase for an already-completed result. Cache hits do not call Seamless research.
3. Select the Seamless organization using strict priority: PRIMARY first; SECONDARY only when PRIMARY reports 0 research credits. A post-submission failover is allowed only after an explicit Seamless `insufficientCredits` rejection. Timeouts, 429s, auth errors, and ambiguous transport failures never fail over automatically.
4. Submit exactly one direct research item:

```json
{
  "contacts": [
    { "liProfileUrl": "https://www.linkedin.com/in/example/" }
  ],
  "skipDeduplicationCheck": false
}
```

5. Require exactly one request ID for automatic polling.
6. Poll that request ID using the exact same API key and egress route that created it.
7. Store the completed result in Supabase.
8. Display only the requested contact fields: name, current company, emails, and normalized phone numbers.

## Credit safety

- No `/search/contacts` runtime call.
- No MCP search runtime call.
- One exact LinkedIn profile per chargeable research submission.
- Deduplication remains enabled (`skipDeduplicationCheck: false`).
- Concurrent clicks are claimed in Supabase before provider submission.
- No automatic retry after ambiguous submission outcomes.
- Polling and credit/status reads are read-only provider operations.
- The UI records the provider-reported balance before/after research and flags deltas greater than 1.
- SECONDARY is standby while PRIMARY has credits; it does not receive a research submission just because it has a larger balance.

## Multiple companies

Seamless only reveals current/former company roles after the contact has been researched. v37 therefore does not run a search or a second enrichment to discover company options before the first result.

If the returned record contains multiple company roles, the UI shows a **company-context chooser** after enrichment. Choosing a company there is local-only and consumes 0 credits. It never silently researches a former company or claims that the returned contact details belong to a former employer.

## Phone formatting

Phone numbers are deduplicated and normalized to international/E.164-style output whenever the returned country can be determined. US/Canadian numbers are displayed like:

```text
+14155550101
```

## Multi-organization routing

Default order:

```text
SEAMLESS_API_KEY_PRIMARY   -> ACTIVE until exhausted
SEAMLESS_API_KEY_SECONDARY -> STANDBY
other configured keys      -> later fallback routes
```

A completed research job remains pinned to its original key and egress route for polling.

If strict unique egress is enabled, configure a distinct proxy/NAT route for each key:

```dotenv
SEAMLESS_API_KEY_PRIMARY=...
SEAMLESS_EGRESS_PROXY_PRIMARY=http://user:pass@proxy-a:port

SEAMLESS_API_KEY_SECONDARY=...
SEAMLESS_EGRESS_PROXY_SECONDARY=http://user:pass@proxy-b:port

SEAMLESS_REQUIRE_UNIQUE_EGRESS=true
SEAMLESS_EGRESS_CHECK_URL=https://api.ipify.org?format=json
```

The app verifies the observed public IPs. Two different observed IPv4 addresses are valid unique egress routes even when their suffixes look similar.

## Credits widget

Each organization balance comes from Seamless's `X-PublicAPI-Credits` response header. The total is the sum of fresh numeric balances from the configured organizations. The UI labels routes as ACTIVE, STANDBY, EXHAUSTED, or UNAVAILABLE.

## Required Render variables

```dotenv
APP_AUTH_TOKEN=your-workspace-password
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-server-side-supabase-key

SEAMLESS_API_KEY_PRIMARY=...
SEAMLESS_API_KEY_SECONDARY=...
SEAMLESS_EGRESS_PROXY_PRIMARY=...
SEAMLESS_EGRESS_PROXY_SECONDARY=...
SEAMLESS_REQUIRE_UNIQUE_EGRESS=true
SEAMLESS_API_BASE_URL=https://api.seamless.ai/api/client/v1
```

## Verify

```sh
npm ci --no-audit --no-fund
npm run build
npm test
```


## v38 routing safety
When more than one Seamless API key is configured, every route must have its own proxy/NAT endpoint and Beast verifies that the observed public egress IPs are distinct before allowing enrichment. If both routes resolve to the same IP, fix the external proxy/NAT configuration; the application cannot create a second public IP by itself.

## v38 phone policy
The contact card intentionally excludes Seamless `companyPhone*` switchboard fields. It displays at most two deduplicated person-level `contactPhone*` values, prioritizing mobile/direct data types.
