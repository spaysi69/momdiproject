# v28

Replaced the broad discovery dashboard with a focused LinkedIn chatbox. Two sidebar items: Enriching and Prospecting (coming soon).

New persistent Supabase person_searches and contact_research tables. Reads come before MCP calls. Research remains company-specific and completed records are reused. Supabase unique inserts protect against concurrent paid submissions. Redis is no longer required.

Apply supabase/schema.sql before starting. See README.md for capability requirements, migration limits, setup, and validation.
