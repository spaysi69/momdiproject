# v26 — Seamless MCP Free Search / Paid Research

## Person workflow

1. `POST /v1/person/search` calls Seamless MCP `search_contacts` only.
2. Search candidates retain the exact `searchResultId`.
3. `POST /v1/person/research` accepts the selected `searchResultId` and calls `research_contacts`.
4. Research is polled with `poll_contact_research`.
5. `/status` reads the provider balance through MCP `get_credits`.

## Configuration

Use `SEAMLESS_MCP_API_KEY` with the Seamless API key connection's MCP scope enabled.
The default MCP endpoint is `https://mcp.seamless.ai/mcp`.
