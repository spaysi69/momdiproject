# Seamless Person Enrichment Service

Final clean build v13

Production-oriented Node.js/TypeScript service for an authorized Seamless.AI Public API integration.

## Person-first workflow

1. Paste one person's LinkedIn profile URL.
2. **Find person** uses Seamless **Contact Search** only. It does not call contact research, reserve research quota, or decrement the research-credit ledger.
3. The matching person and the company information available from the search result are shown. Company records are clickable when multiple records are available in the returned data.
4. **Enrich this person** is the paid action. It calls Seamless **Contact Research** and consumes one tracked research credit when the provider accepts the research request.
5. Completed enrichment is stored in Redis/Supabase so the same person/company can be returned from cache without another provider research request.

## Endpoints

- `POST /v1/person/companies` — authenticated free person lookup through `/search/contacts`.
- `POST /v1/enrich-person-company` — authenticated paid enrichment through `/contacts/research`.
- `GET /status` — authenticated route, quota, and tracked-credit status.
- `GET /health` and `GET /ready` — deployment health checks.

The removed legacy company-wide search/enrich endpoints are intentionally not exposed by the app.

## Credits

Search and research are kept separate. The local credit ledger is decremented only after a `/contacts/research` request is accepted by the provider. Search itself does not decrement this ledger.

## Phone formatting

North-American numbers are normalized to `0+1XXXXXXXXXX` with no spaces, dots, dashes, or parentheses. Other international numbers keep their country code without punctuation.

## Security

The access code is held only in browser memory, so reloading the page requires signing in again. Provider API keys, Supabase credentials, and Redis credentials remain server-side and must never be committed.

## Search behavior

“Find person” uses Seamless Contact Search only. It does not call `/contacts/research` or decrement the research credit ledger. The UI has a 12-second request timeout, while each provider search request is capped at 8 seconds. The free search path does not touch Redis or Supabase. Exact LinkedIn URL matching is required before a person is shown. If the provider rejects or times out, the exact HTTP/provider error is returned.

## v2.1.1 search hardening

The served HTML is no-store to prevent stale browser/proxy copies. Free person lookup checks Redis first and then performs only the documented Contact Search calls; the persistence layer is not on the free-search critical path.
