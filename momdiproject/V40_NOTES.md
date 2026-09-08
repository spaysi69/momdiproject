# v40.0.0 — One-page UX + strict fresh credit display

- Removed required proxy / egress-IP routing from the application.
- PRIMARY-first, SECONDARY-after-exhaustion routing remains.
- Rebuilt enrichment workspace into a fixed one-page studio.
- New results auto-slide into the visible result viewport.
- Previous session results remain as scroll-snap slides; scroll up to revisit them.
- Compact result card keeps name, company, emails and numbers visible without a long page scroll.
- Other contact data and employment history are collapsible drawers.
- Credit totals come only from fresh `X-PublicAPI-Credits` headers.
- Combined balance is withheld if any configured organization fails to return a fresh numeric header.
- Credit snapshots auto-refresh every 10 seconds, on tab focus, on credit-panel open, and after completed research.
- No stale balance is used as the displayed total.
- Direct one-profile research safety rules remain unchanged.
