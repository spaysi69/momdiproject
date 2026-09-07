# v34.0.0

- Free contact search scans up to three 50-result pages (150 same-name results) using `supplementalData.nextToken`, stopping early when an exact LinkedIn URL match is found.
- Main result contains only an exact LinkedIn URL match.
- Non-exact same-name results are hidden behind an optional "possible matches" disclosure.
- Credit widget refreshes on open and every 15 seconds.
- Credit totals use only fresh numeric `X-PublicAPI-Credits` values.
- Missing fresh credit headers are treated as unavailable; stale balances are never silently counted.
- Existing v33 multi-org unique-egress routing remains intact.
