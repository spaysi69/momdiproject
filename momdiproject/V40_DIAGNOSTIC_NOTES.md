# v40.1.0-test Diagnostic Capture

This build exists only to observe the exact Seamless API behavior for one direct LinkedIn enrichment.

- No contact-search endpoint or MCP search.
- Exactly one contact is submitted to `/contacts/research`.
- API/auth secrets are redacted from the diagnostic trace.
- Provider response bodies and returned contact data are intentionally preserved for debugging.
- The report records preflight credit probe, research POST, every poll, and final credit probe.
- Diagnostic capture itself makes zero additional Seamless calls.
- Background 10-second credit polling is disabled in this test build to reduce unrelated provider traffic while testing.

After an enrichment, expand **Seamless diagnostic trace** and click **Copy diagnostic report**.
