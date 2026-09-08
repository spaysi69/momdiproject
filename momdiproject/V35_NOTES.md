# v35.0.0 — MCP Search Credit Firewall

This hotfix removes REST `POST /search/contacts` from discovery after a real deployment observed a 29-credit balance drop during one v34 lookup.

## Safety model

- Search button: MCP `search_contacts` only (`fullname`, limit 50).
- No REST `/search/contacts` implementation exists in production source.
- Candidate enrichment: MCP `research_contacts` with the selected `searchResultId`.
- Candidate polling: MCP `poll_contact_research` on the same organization/egress route.
- Exact LinkedIn fallback: REST `POST /contacts/research` only after explicit confirmation.
- Credits: provider header snapshots are sampled immediately before and after MCP discovery. Any decrease is surfaced as a credit anomaly rather than claimed as zero usage.
- Multi-org egress routing from v33 is preserved.

## Required Seamless connection scopes

Each API-key connection used for discovery must have MCP enabled. Public API v1 remains required for direct LinkedIn research and credit-header reads.

## Regression guarantees

The automated suite fails if the production search implementation contains `/search/contacts`.
