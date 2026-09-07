# Prospecting Beast 28

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

Open http://localhost:3000. Click **Connect workspace**, enter APP_AUTH_TOKEN, then paste the LinkedIn link. The token stays in page memory; reconnect after refreshing. Provider/database secrets never enter the browser.

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

Production TypeScript build, frontend syntax, and 21 automated tests passed. Tests cover database-first lookup, preserving multiple companies, repeat lookups without provider calls, completed enrichment after restart, concurrent submissions, uncertain outcomes, database failure, record ownership, and MCP response parsing. Database/provider behavior is mocked in these tests. Live Seamless, Supabase, deployment, and browser visual QA were not performed without a configured environment.
