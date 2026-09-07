# Prospecting Beast 29.1

A LinkedIn enrichment chatbox.

1. Paste a person's LinkedIn profile URL and press Enter.
2. Review the company records Seamless returns for that person.
3. Click **Enrich contact** on the company you want, then confirm.
4. The available email and phone appear in that company card.

The sidebar contains only **Enriching** and **Prospecting — coming soon**.

## Set up

Use Node.js 24. In Supabase's SQL editor, run the included `supabase/schema.sql`. This adds two tables and preserves the existing enrichment_profiles table.

Configure the server environment:

```dotenv
APP_AUTH_TOKEN=your-long-random-workspace-token
SEAMLESS_MCP_API_KEY=your-mcp-enabled-seamless-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-server-secret
```

The Seamless API-key connection must have MCP access enabled. Supabase is required in this version. Use a secret/service-role key on the server, never an anonymous browser key.

For local use, put the values in `.env`, then:

```sh
npm ci
npm run build
npm test
node --env-file=.env dist/src/index.js
```

Open http://localhost:3000. The password page appears first. Enter the value of APP_AUTH_TOKEN to open the app, then paste the LinkedIn link. Every reload asks for the password again. No cookie, localStorage, or sessionStorage remembers it. The workspace HTML, script, and data endpoints all require authentication. Seamless and Supabase secrets remain on the server. Login succeeds independently of provider health; connection problems appear inside the app.

Render: apply the SQL first, then configure the supplied render.yaml service and its four secrets. Docker is also supported. In managed hosting use `npm start`; local `.env` loading uses the explicit command above. No live deployment was performed in this delivery.

## Free search and paid enrichment

The search endpoint calls only Seamless MCP `search_contacts`. It never calls research_contacts, REST search, or a paid fallback. Only selecting a company and confirming enrichment invokes research_contacts, using that company's exact searchResultId. Polling does not submit another enrichment.

Official documentation:

- [MCP search: no credits](https://docs.seamless.ai/mcp/tools/search)
- [MCP research: consumes credits](https://docs.seamless.ai/mcp/tools/research)
- [API-key authentication and MCP scope](https://docs.seamless.ai/mcp/authentication)

**LinkedIn capability:** Seamless's published basic search documentation does not guarantee a LinkedIn URL filter. The app discovers the actual search_contacts input schema with tools/list and uses its advertised LinkedIn field. If that field is absent, new URL lookups stop with an explicit explanation and no research call; saved Supabase profiles still load. There is no claim that the MCP search has identical coverage to the Seamless browser extension. Your live MCP key is needed to verify this capability. Up to 100 returned company records are requested per lookup; the app does not reconstruct a complete employment history or label unmarked records as current.

## Supabase reuse

- `person_searches`: canonical LinkedIn URL → person and all returned company candidates. The app reads this table before making any Seamless search. Positive and empty searches are saved without automatic expiry.
- `contact_research`: exact searchResultId → linked person, submission state, request IDs, and enriched contact details. Separate company records remain separate.
- On repeat lookup, saved research is joined into the company's card. Completed details are loaded from Supabase without calling research again.
- An atomic unique insert claims each research record before a paid call. This works across multiple server instances and app restarts. Redis is no longer required by the active application.
- Supabase failure is reported; the app does not silently fall back to provider operations.
- Row-level security blocks browser anon/authenticated access; the server service role owns these tables.

A saved result may become stale. There is intentionally no automatic refresh or re-enrichment that could replace saved records or spend credits. Empty saved searches also require an operator to remove that one person_searches row if a fresh search is desired, provided no research rows refer to it.

If a provider submission times out, the database retains a needs_review marker. A submitting marker left over after two minutes is also shown as needing review. The app never guesses whether a charge occurred and never automatically re-submits. Check Seamless before an operator resolves the record. A failed database write after submission leaves the pre-submission marker intact to prevent duplicate billing. No automatic paid retry is implemented.

## Upgrade from v27

Apply the full SQL file (safe to re-run), set both Supabase values, then replace the app files and rebuild. This version replaces the table/shortlist interface with the requested chat workflow and makes Supabase the source of truth.

Old enrichment_profiles rows remain untouched. They do not reliably identify the selected company record, so they are not automatically attached to new searchResultIds. Old browser shortlists and Redis jobs are not imported. Finish outstanding v27 research before upgrading and retain backups if you need to migrate historical results manually. New v28 searches and enrichments persist in the new tables.

The broad company/name search endpoint was removed from the active server; prospecting is deliberately coming soon. Existing legacy source modules remain for compatibility, but are not invoked by the chatbox. Active API routes are /v1/person/search, /v1/person/research, /v1/person/research/status, and /status, protected by APP_AUTH_TOKEN. Research submission requires linkedinUrl and searchResultId; polling requires searchResultId.

## Verification

Production TypeScript build, frontend syntax, and 30 automated tests passed. Tests cover database-first lookup, preserving multiple companies, repeat lookups without provider calls, completed enrichment after restart, concurrent submissions, uncertain outcomes, database failure, record ownership, and MCP response parsing. Database/provider behavior is mocked in these tests. Live Seamless, Supabase, deployment, and browser visual QA were not performed without a configured environment.


## v29: resolving a Seamless 403

A workspace login error and a Seamless 403 are separate. The app now checks your password before loading any workspace HTML or app script; a Seamless outage does not reject a correct password.

Inside the app, **Check connection** identifies the selected server key by environment-variable name only. Default priority is SEAMLESS_MCP_API_KEY, SEAMLESS_API_KEY_PRIMARY, SEAMLESS_API_KEY_SECONDARY, then SEAMLESS_API_KEY_3 through SEAMLESS_API_KEY_5. A stale MCP key can take precedence over an updated primary key. To explicitly choose the primary key shown in your Render configuration, set:

```dotenv
SEAMLESS_MCP_KEY_SOURCE=SEAMLESS_API_KEY_PRIMARY
```

Use that setting only if primary is the intended MCP-enabled API key. Other supported key variable names can be selected the same way. APP_AUTH_TOKEN is exclusively the workspace password; APP_API_TOKEN and ADMIN_API_TOKEN are not Seamless credentials.

A 403 is an access refusal, not evidence by itself that requests look malicious. Confirm that the selected key's connection has MCP scope, the correct group, and account-level MCP access. If all are correct, ask Seamless support to investigate the denial. A known scope/disabled-access reason is displayed when the provider supplies it; otherwise the app states that the exact reason is unavailable. It never echoes raw provider error bodies.

Keys are explicitly selected, not rotated to evade access restrictions. No proxy/IP rotation, browser fingerprint spoofing, or automatic retry of denied paid requests is included. Supabase reuse and existing request deduplication reduce unnecessary traffic. New saved searches/jobs are bound to the selected key using a one-way fingerprint; after changing keys, restore the original key to research its saved candidates or resume pending jobs. Completed records remain readable without using a key.

The live 403 has not been reproduced or resolved in your Render account from this environment. This release improves diagnosis and correct key selection; it cannot grant missing provider permissions. No database migration beyond the existing v28 schema is needed.


## v29.1: search-schema detection

The previous error saying Seamless must enable a LinkedIn filter was too conclusive: the app checked only four top-level spellings. The corrected detection handles camel/snake case, nested filter objects, nullable types, composition, and local JSON Schema references. It does not substitute a profile URL for a person's name or use a paid fallback. Provider-default result limits apply.

If the field still cannot be identified, click **Copy search diagnostic** and share its JSON with the developer. It contains search_contacts tool documentation/schema, not your API key or contact records. The endpoint is authenticated. This distinguishes an unsupported filter from a parser incompatibility. No live tools/list response from your connection has been inspected in this environment, so URL-only support remains unconfirmed.

Production build and 30 tests passed. Tests use schema fixtures; they do not demonstrate live LinkedIn lookup on your account. No Supabase migration is needed for this patch.
