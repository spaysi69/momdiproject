# Prospecting Beast v26 — Seamless MCP person-first

This release fixes the person lookup architecture around Seamless.AI's documented MCP flow.

## Person workflow

1. Paste a LinkedIn profile URL.
2. `search_contacts` is called through the hosted Seamless MCP endpoint. Seamless documents contact/company search as read-only and not consuming credits.
3. The returned `searchResultId` is retained in the browser/server response.
4. Only when the user clicks **Enrich this person**, `research_contacts` is called with that exact `searchResultId`.
5. Research is polled with `poll_contact_research` until completion or a bounded timeout.
6. Results are cached and persisted in Supabase.

The application never calls REST `/search/contacts` for the person-discovery step.

## Seamless credentials

Create an API-key connection in Seamless with the **MCP** scope enabled and set it as `SEAMLESS_MCP_API_KEY`. The documented MCP API-key flow sends the key in the `Token` header to `https://mcp.seamless.ai/mcp`.

## Credits

The dashboard uses the Seamless MCP credit tool for current credit information. It does not maintain a fake local decrementing balance.

## Security

- `APP_AUTH_TOKEN` protects the application API.
- The sign-in token is kept in browser memory, so a full page reload requires signing in again.
- Seamless credentials remain server-side.
- Do not commit `.env` or provider credentials.
