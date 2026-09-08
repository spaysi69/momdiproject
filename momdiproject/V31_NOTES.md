# v31.0.1

- Removed the MCP LinkedIn URL search path.
- Removed MCP tool discovery, diagnostics, Redis, and searchResultId selection from the active app.
- Added direct REST contact research using `contacts[].liProfileUrl`.
- Keeps `skipDeduplicationCheck: false`.
- Added REST polling by request ID.
- Reads `X-PublicAPI-Credits` instead of an internal/fake balance.
- Lookup is Supabase-first and never submits research.
- One deterministic database claim per normalized LinkedIn URL prevents duplicate concurrent research submissions.
- Existing v30 Supabase schema is reused.
- Existing `SEAMLESS_API_KEY_PRIMARY` deployments remain compatible.

## v31.0.1 hotfix

- Fixed the Seamless org-contact credit probe. `GET /contacts` requires `startDate` and `endDate`; v31.0.0 omitted them.
- The probe now sends a one-minute ISO8601 UTC window (`yyyy-mm-ddThh:mm:ssZ`) and `limit=1`.
- This remains an org-data read and does **not** start contact research or consume a research credit.
- Added a regression test that validates both timestamps and their one-minute ordering.
