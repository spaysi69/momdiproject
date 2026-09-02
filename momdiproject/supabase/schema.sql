create table if not exists public.enrichment_profiles (
  id bigint generated always as identity primary key,
  normalized_url text not null unique,
  profile jsonb not null,
  first_enriched_at timestamptz not null default now(),
  last_enriched_at timestamptz not null default now()
);

create index if not exists enrichment_profiles_last_enriched_idx
  on public.enrichment_profiles (last_enriched_at desc);

-- Keep the table protected from browser/public roles. The server uses a Supabase secret
-- key (or the legacy service_role key) and performs all reads/writes server-side.
alter table public.enrichment_profiles enable row level security;
revoke all on table public.enrichment_profiles from anon, authenticated;
grant all on table public.enrichment_profiles to service_role;
