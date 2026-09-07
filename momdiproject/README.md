# Prospecting Beast 27

A redesigned prospecting workspace for Seamless.AI MCP. Company/name/title discovery, LinkedIn lookup when supported by the connection, a selectable contact table, local shortlists, CSV export, and deliberate contact research.

## Start locally

Use Node.js 24 and a reachable Redis instance. Redis is required for research state and duplicate-request protection. Configure a persistent Redis service with a no-eviction policy in production; losing its records also loses deduplication history.

1. Copy `.env.example` to `.env` and enter your own values.
2. Set `REDIS_URL`, `APP_AUTH_TOKEN` (a long random secret), and `SEAMLESS_MCP_API_KEY`.
3. Enable the MCP scope on the Seamless API-key connection.
4. Run:

```sh
npm ci
npm run build
npm test
node --env-file=.env dist/src/index.js
```

Open http://localhost:3000 and use **Connect workspace**. Enter `APP_AUTH_TOKEN`, not your Seamless key. The browser keeps this token in memory only. Refreshing requires reconnecting. On managed hosting, set environment variables in the host dashboard and use `npm start`.

Supabase is optional. If used, configure both `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, then apply `supabase/schema.sql`. Existing enrichment_profiles records are preserved. Supabase sync failures do not repeat paid research. Shortlists, recent searches, and activity are stored only in this browser, not Supabase; export them before clearing browser data.

## Workflow

- Enter a company name, job title, or person's name. Commas separate multiple values. The default result cap is 20; the maximum is 100.
- Search returns discovery records without initiating research. Select candidates, save a shortlist, or filter the displayed results.
- Choose **Enrich** and confirm the selected count. The server passes exact provider searchResultIds to research_contacts, then the browser polls existing requests.
- **Resume** checks an existing request. It does not submit a second paid research call. Results and pending items are automatically saved in the browser shortlist.
- Export visible contacts, or selected contacts, to CSV. Potential spreadsheet formula prefixes are escaped.
- Press `/` to focus search. All dialogs can be closed with Escape.

## Seamless integration

Official references reviewed on 7 September 2026:

- [Authentication](https://docs.seamless.ai/mcp/authentication): MCP-scoped API key in the `Token` header, endpoint `https://mcp.seamless.ai/mcp`.
- [Search](https://docs.seamless.ai/mcp/tools/search): free discovery, companyName/jobTitle/fullname arrays, result limit.
- [Research](https://docs.seamless.ai/mcp/tools/research): credit-consuming research_contacts with searchResultIds, asynchronous poll_contact_research with requestIds.
- [User tools](https://docs.seamless.ai/mcp/tools/user): provider credit information.
- [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports): JSON and SSE response handling.

The client follows Seamless's documented direct JSON-RPC HTTP request examples. It accepts JSON and SSE responses and checks response IDs. This is a focused Seamless client, not a general-purpose MCP SDK with OAuth/session negotiation.

LinkedIn URL filtering is not part of the published basic search schema. The app inspects tools/list and uses a LinkedIn field only when the connection advertises one. Otherwise it asks you to search by name and company. It never disguises a URL as a name filter.

No assumed per-contact charge is displayed. Credit balances come from get_credits; an unrecognized balance is shown as unavailable rather than fabricated.

## API

All data routes require `Authorization: Bearer <APP_AUTH_TOKEN>`.

| Route | Purpose |
| --- | --- |
| GET /health | Process health and version |
| GET /ready | Redis readiness |
| GET /status | Seamless access and reported credit information |
| POST /v1/contacts/search | companyName, jobTitle, fullname, seniority arrays; limit 1–100 |
| POST /v1/person/search | LinkedIn URL lookup using advertised provider schema |
| POST /v1/person/research | Submit/resume one searchResultId; optional linkedinUrl, personName, companyName |
| POST /v1/person/research/status | Poll by searchResultId |

Research routes now return promptly; frontend polling uses searchResultId, not LinkedIn URL. Update external callers accordingly. Older URL-keyed v26 pending jobs cannot be resumed through v27: complete any pending research before upgrading and retain a Redis backup.

## Research recovery

Jobs are keyed by exact searchResultId, not profile URL. A Redis NX lock and durable pre-submission marker protect against concurrent or repeated paid calls. Completed job results are retained in Redis; cache TTL alone does not force re-enrichment.

If a submission times out or returns no request ID, the record is marked `needs_review`. The app does not guess whether Seamless charged you and does not auto-resubmit. An operator must check Seamless before changing the affected Redis job. Failed jobs also remain recorded; there is no automatic paid retry. Do not delete research-job records simply to retry an uncertain request.

For completion responses that provide no parsable contact data, the job remains resumable. Production response variations may require additional parsing after observing the live provider response.

## Deploy

`render.yaml` provides the Node service plus Redis. Configure secrets in Render. The Dockerfile uses Node 24, npm ci, and the committed lockfile. Both deployments listen on 0.0.0.0 and respect PORT. This delivery does not deploy or modify a live service.

## Verification and scope

- Dependency installation and TypeScript production build passed.
- 15 automated tests passed, including original normalization tests and mocked MCP/research regression coverage.
- Frontend JavaScript syntax checked.
- No browser visual test, live Redis integration test, Supabase integration test, or live Seamless request was performed in this environment. Configure your key and verify connection → search → one explicitly chosen enrichment before production use.

The uploaded v26 ZIP does not include the older Python/Tavily/Gemini/corporate-family engine described in the accompanying history. This release improves the actual supplied Node project; it does not claim to restore absent modules. Unused legacy REST/core modules are retained for source compatibility but are not connected to the active UI. The duplicated root frontend.js was removed; src/server/public is the canonical frontend.
