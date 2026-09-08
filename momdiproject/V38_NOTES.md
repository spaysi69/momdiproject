# v38.0.0 — Strict Egress + Contact-Only Phones

- Multi-organization mode now requires verified distinct public egress IPs by default.
- Research is blocked when PRIMARY and SECONDARY resolve to the same public IP.
- Route status exposes a sanitized proxy endpoint (host/port only) to diagnose accidental proxy reuse.
- Contact cards no longer include companyPhone1/companyPhone2/companyPhone3.
- Phone output uses contactPhone1/contactPhone2 only, prioritizes mobile/direct person-level numbers, deduplicates, and caps display at two.
- Company/main/switchboard numbers are used only as a fallback if no stronger contact number exists.
