# Prospecting Beast v34 — Exact Match + Live Credit Snapshots

v34 keeps the v33 multi-organization / unique-egress architecture and tightens two behaviors: free LinkedIn candidate matching and credit-balance accuracy.

## LinkedIn lookup

1. Paste a LinkedIn person URL.
2. Beast checks Supabase first.
3. If uncached, Beast infers a searchable full name from a normal LinkedIn slug and runs Seamless `POST /search/contacts` with `fullName` and `limit: 50` on each configured organization, following `supplementalData.nextToken` for up to three pages (150 results) and stopping early on an exact match.
4. Beast normalizes every returned `liUrl` and compares it to the pasted LinkedIn URL.
5. If an exact URL match exists, **only that exact person** is shown in the main result.
6. If no exact URL match exists, Beast says so instead of dumping same-name people into the main result. Possible name matches are hidden behind an optional disclosure.
7. Research only starts after explicit confirmation. Exact-URL direct research remains the fallback and can consume a research credit.

The free search endpoint does not document a LinkedIn-URL request filter; exactness is therefore verified against the returned `liUrl` values before research.

## Credits

Each organization is queried independently. The displayed number comes from the fresh `X-PublicAPI-Credits` header returned by Seamless. v34 does **not** use a locally decremented quota and does **not** substitute a stale cached number when a fresh header is missing.

The total is shown only from routes that successfully returned a numeric fresh balance. Clicking the credit widget forces a refresh, and the workspace refreshes balances every 15 seconds. Each row includes the observation time.

A provider balance is authoritative at the instant the response was received; another process or user can spend credits immediately after that snapshot.

## Multi-organization / egress variables

```dotenv
APP_AUTH_TOKEN=your-workspace-password
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-server-side-supabase-key

SEAMLESS_API_KEY_PRIMARY=...
SEAMLESS_EGRESS_PROXY_PRIMARY=http://user:pass@proxy-a:port

SEAMLESS_API_KEY_SECONDARY=...
SEAMLESS_EGRESS_PROXY_SECONDARY=http://user:pass@proxy-b:port

SEAMLESS_REQUIRE_UNIQUE_EGRESS=true
```

Each research job stores its route ID so submission and polling remain pinned to the same Seamless organization and egress route.

## Verification

```sh
npm ci
npm run build
npm test
```

The test suite covers exact LinkedIn URL filtering, no-exact-match behavior, fresh credit headers, stale-credit rejection, multi-org totals, distinct egress verification, route-pinned research/polling, authentication, and duplicate-research protection.
