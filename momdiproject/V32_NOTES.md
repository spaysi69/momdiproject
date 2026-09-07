# v32.0.0 — Search-first enrichment + UI redesign

- Free Seamless `POST /search/contacts` discovery happens before research.
- LinkedIn slug is used only to derive a search name; candidates are returned with name, company, title, location and LinkedIn URL.
- Exact LinkedIn URL matches are ranked first and clearly labeled.
- Research uses the selected candidate's documented `searchResultId`.
- Polling starts only after explicit enrichment and keeps the selected name/company visible.
- Direct LinkedIn research is retained only as an explicit fallback when free discovery cannot identify a candidate.
- Credits are labeled as an organization-wide provider snapshot from `X-PublicAPI-Credits`.
- Complete dark UI redesign with candidate cards, confirmation modal, progress state and enriched contact panel.
