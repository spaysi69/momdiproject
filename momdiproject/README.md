# Enrichment Service

Production-oriented Node.js/TypeScript service for an authorized Seamless.AI Public API integration.

## Company-first workflow

The web app now mirrors the search → select → research workflow:

1. Search for a company by name.
2. Select the company returned by Seamless.
3. Load contacts scoped to that selected company.
4. Select the people you actually want to research.
5. Research only those selected contacts, with one tracked provider research credit per submitted contact.

The provider adapter uses Seamless's current documented search and contact-research endpoints. Contact search results return `searchResultId` values, which are then passed to `/contacts/research` for the selected people. This is the documented search-then-research workflow.

## API

- `POST /v1/search/companies` — authenticated JSON body `{ "query": "Microsoft" }`.
- `POST /v1/search/contacts` — authenticated JSON body containing `companyName` and/or `companyDomain`.
- `POST /v1/enrich-selected` — authenticated JSON body `{ "searchResultIds": ["..."] }`.
- `POST /v1/enrich` — retained for direct LinkedIn-profile enrichment when a profile URL is already known.
- `GET /status` — authenticated service/quota status.
- `GET /health` and `GET /ready` — deployment health checks.

Provider credentials remain server-side. The browser only receives the application's own sign-in prompt and never receives provider credentials.

## Credits

The server-side credit ledger is initialized from `credits.starting` and decremented when the provider accepts a contact research request. Search operations do not consume a tracked research credit. Keep the configured starting balance aligned with the provider account you are authorized to use.

## UI

The sign-in code is held only in page memory, so a full page reload requires signing in again. Results are inserted at the top of the scrollable enrichment history with a smooth entrance animation.

Do not commit `.env`, provider API keys, Supabase secrets, or other credentials.
