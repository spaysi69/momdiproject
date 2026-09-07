# v27 upgrade notes

## Interface
- Replaced the single crowded inline page with separate HTML, CSS, and JavaScript.
- Forest-green workspace navigation, focused search, responsive table, contact details, selectable rows, and real empty/error/loading states.
- Added company/name/title discovery, advanced seniority and result caps, recent filters, local shortlists, activity, and CSV export.
- Added memory-only access-token setup and live provider credit status.

## Integration and reliability
- Fixed dangling-else bug that dropped scalar requestId values.
- Preserved blank Markdown table cells and normalized human-readable column headings.
- Removed generic id fallback for paid searchResultIds.
- Removed guessed LinkedIn search filters and forced current-employer flags.
- Added Accept headers, streamed SSE parsing, response-ID checks, and malformed tools/list rejection.
- Keyed research by provider result ID with Redis concurrency protection and durable submission markers.
- Kept ambiguous submission outcomes for review instead of automatic paid retries.
- Returned asynchronous research promptly, preserved completed jobs for repeat polling, and handled immediate completion.
- Made Supabase optional; sync errors cannot cause repeat research.
- Removed fabricated creditsCharged counters; credits come from the provider.
- Added a lockfile and reproducible Docker/Render installation.

See README.md for setup, migration requirements, verification limits, and official documentation links. No production key or credentials are included.
