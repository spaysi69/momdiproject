# Prospecting Beast v47 — Multi-Path Discovery

v47 rebuilds prospecting around independent discovery paths and fixes the zero-result failure mode seen with Intel/Cybersecurity Manager.

## Key changes

- Complex public OSINT queries that return zero results are recursively decomposed into smaller title bundles and finally single-title searches instead of being treated as exhausted.
- Single-title strict dorks retry with a looser LinkedIn-profile query when the strict form returns zero.
- Public discovery now supports Bing RSS + HTML fallback, DuckDuckGo HTML + Lite fallback, Yahoo HTML, and optional SearXNG.
- LinkedIn Direct now uses multiple current Voyager search query IDs and multiple query shapes.
- Authenticated server-rendered LinkedIn People search is a fallback when Voyager returns zero or its response shape changes.
- Company resolution is multi-path: explicit company URL, LinkedIn company UI, organization universal-name endpoint, slug candidates, then GraphQL company search.
- Cybersecurity Manager ontology expanded with enterprise information-security/security-engineering/security-operations variants.
- Direct-search telemetry records query strategy, UI fallback count, GraphQL/UI hits, stage, and true request count.
- The UI no longer presents `circuit CLOSED` as a success signal. Circuit state is surfaced only when OPEN/HALF_OPEN or otherwise relevant.
- Existing Stop button, collapsible role selector, persistent LinkedIn session, pacing, circuit breaker, and all v42 enrichment safeguards are retained.

## Validation target

Tests include an Intel-shaped fixture for an Information Security Manager LinkedIn profile and require discovery through multiple public parser formats, role matching, zero-result decomposition, and LinkedIn UI fallback behavior.
