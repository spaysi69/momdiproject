# v41 Deep Diagnostic Test

- Added an in-memory global diagnostic journal covering provider, credits, routing, storage, research, polling, parsing, status and browser events.
- Added correlation IDs for Seamless HTTP calls.
- Added cause labels to every credit/status refresh.
- Added derived credit timelines and per-route provider series.
- Added derived counts for research POSTs, submitted contacts, polls, balance reads and request IDs.
- Added invariant checks for one contact per research POST, deduplication enabled, no contact-search endpoint and no MCP.
- Added top-bar Diagnostics dialog with Copy FULL report, Download JSON and Reset trace + baseline.
- Added browser-side telemetry so the report shows what the user actually saw in the credit indicator and result UI.
- Diagnostic report/reset endpoints make no Seamless provider request by themselves.
- Preserved v40 one-page UX and conservative enrichment flow.
