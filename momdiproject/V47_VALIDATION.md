# v47 Validation Report

- Build: 47.0.0 / a379a5512b11
- Full Node test suite: 70/70 PASS
- Production server startup: PASS
- `/health`: PASS; reports `enrichment-plus-prospecting-multipath-linkedin-adaptive`
- Authenticated `/workspace`: HTTP 200
- `/v1/prospect/roles`: 12 Flagged families, 15 Not Flagged families
- Intel/Cybersecurity deterministic service simulation: PASS
  - zero-result compound query decomposed recursively
  - discovered David Pritchard fixture as `Information Security Manager` at Intel
  - 31 adaptive partitions exercised in the fixture run
- Existing v42 Seamless one-contact/one-research safeguards: retained and passing
- No real LinkedIn cookies are bundled in the source or package.

A live authenticated LinkedIn Direct run cannot be performed in the build environment because the user's LinkedIn session cookies are intentionally not present. The collector's live-session-specific behavior must therefore be validated on the deployed Render instance after configuration.
