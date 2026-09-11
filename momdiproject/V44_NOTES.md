# v44 — LinkedIn Direct + Adaptive Partitioning

Version: 44.0.0

## Added

- authenticated LinkedIn Direct collector
- Chromium same-origin Voyager transport with authenticated-fetch fallback
- company-name → LinkedIn company ID resolution
- current-company filtered people search
- role-alias direct search and pagination
- adaptive network-depth partitions for oversized LinkedIn buckets
- recursive alias splitting for saturated public OSINT queries
- round-robin role scheduling under the LinkedIn direct request budget
- LinkedIn Direct capability/status reporting in the Prospecting UI
- LinkedIn Direct result provenance and direct-source counts
- runtime Chromium installation in Docker

## Preserved

- complete v42 Enriching / Seamless safety architecture
- v43 Flagged and Not Flagged role ontology
- Bing, DuckDuckGo and optional SearXNG public discovery
- canonical LinkedIn URL deduplication
- role/current-employment confidence scoring
- CSV export
- zero Seamless research from Prospecting

## Direct collector stop conditions

The direct source halts on LinkedIn login/checkpoint/challenge responses, HTTP 999, or rate limiting. It does not attempt challenge solving. Public OSINT remains independent and may continue.
