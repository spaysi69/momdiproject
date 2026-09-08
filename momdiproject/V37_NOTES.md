# v37.0.0

- Removed the pre-research confirmation modal.
- One click now performs cache check -> exact LinkedIn research -> poll -> organized contact card.
- Strict PRIMARY-first organization routing; SECONDARY is standby until PRIMARY reaches 0 credits.
- Explicit `insufficientCredits` is the only safe automatic failover condition after an attempted submit.
- Polling remains pinned to the submitting key/egress route.
- Credit UI now labels ACTIVE / STANDBY / EXHAUSTED / UNAVAILABLE.
- Clean result output: name, current company, emails, phone numbers.
- Phone normalization to E.164-style where country metadata permits; US/Canada output uses +1XXXXXXXXXX.
- Multiple returned company roles produce a zero-credit local company-context chooser. No hidden second enrichment.
- No contact-search or MCP runtime code.
