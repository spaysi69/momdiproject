# Prospecting Beast v42 Final

Production-oriented LinkedIn contact enrichment using Seamless Public API v1.

## Core behavior
- Paste one exact LinkedIn person URL and click Enrich.
- Cache is checked first.
- New profiles submit exactly one `POST /contacts/research` containing exactly one `liProfileUrl`.
- `skipDeduplicationCheck` remains `false`.
- PRIMARY is used while its fresh org credit balance is above 0; SECONDARY is standby until PRIMARY is confirmed exhausted.
- No contact-search fan-out and no automatic retry after an ambiguous submission outcome.

## Credits
The UI uses only Seamless `X-PublicAPI-Credits` response headers as the fresh balance source. `GET /contacts` is used for a lightweight org-data probe and does not start research. The total is shown only when every configured route returned a fresh numeric header. With multiple keys, the combined total assumes the configured keys represent distinct Seamless organizations.

## Contact quality
- Email candidates marked `valid` or selected by Seamless appear in the main card; invalid/low-confidence candidates are collapsed under Other provider candidates.
- Person phones inspect `contactPhone1`, `contactPhone2`, and `contactPhone3`.
- US/Canada numbers that do not fit NANP length are excluded from the main card instead of being blindly prefixed with +1.
- Company phones remain associated with the current company; low-confidence company phones are collapsed.
- Displayed phone numbers use the requested `0+...` format while internal values remain normalized with leading `+`.

## Required environment variables
- `SEAMLESS_API_KEY_PRIMARY`
- `SEAMLESS_API_KEY_SECONDARY` (optional)
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `APP_AUTH_TOKEN`

No proxy/egress variables are required.
