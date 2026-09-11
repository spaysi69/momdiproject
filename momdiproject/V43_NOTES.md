# v43 — Prospecting Studio

- Replaces the Prospecting “Coming soon” screen with a functional employee discovery workspace.
- Company-name input; no LinkedIn company URL required.
- Flagged vs Not Flagged role sets with the supplied extensive equivalents embedded into the query planner.
- Individual role-family selection plus Select all / Clear.
- Asynchronous discovery jobs with live progress and partial results.
- Public LinkedIn profile discovery via configurable SearXNG plus Bing RSS and DuckDuckGo HTML fallbacks.
- Canonical LinkedIn URL normalization and cross-source deduplication.
- Separate role-match and current-employment confidence.
- Source provenance retained per employee.
- Enriching v42 workflow preserved unchanged.

## Recommended deployment
For the strongest free/open-source search coverage, self-host SearXNG and set `SEARXNG_BASE_URL`.
The built-in Bing + DuckDuckGo collectors remain fallbacks when SearXNG is absent.
