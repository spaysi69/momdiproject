# Prospecting Beast v46

- Added a real server-side Stop Prospecting endpoint and cooperative cancellation across public OSINT and LinkedIn Direct loops.
- Added a Stop button that preserves already-found employees.
- Moved role selection into a collapsed Target Roles bar; it expands only when needed.
- Added LinkedIn Direct staged diagnostics: session verification, company resolution, employee search.
- Fixed misleading `0 req` reporting on early LinkedIn Direct failures by reporting attempted requests from the collector stage.
- Preserves v45 persistent session, queue, rate controller, circuit breaker, adaptive partitioning, and all v42 enrichment safety invariants.
