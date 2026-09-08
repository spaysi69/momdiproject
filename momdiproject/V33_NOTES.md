# v33.0.0

- Added automatic multi-organization Seamless key discovery.
- Added `SEAMLESS_API_KEY_SECONDARY` and arbitrary suffix support.
- Added per-key `SEAMLESS_EGRESS_PROXY_<SUFFIX>` routing.
- Added strict externally observed unique-IP verification.
- Added separate per-organization credit snapshots and total credits.
- Free contact search runs across configured organizations and merges duplicate candidates.
- Candidate `searchResultId` stays bound to the organization that produced it.
- Research and polling are pinned to the same key/egress route.
- UI credit dialog now shows each organization, credits, egress IP and health.
- 26 automated tests.
