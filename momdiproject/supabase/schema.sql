create table if not exists public.enrichment_profiles (
  id bigint generated always as identity primary key,
  normalized_url text not null unique,
  profile jsonb not null,
  first_enriched_at timestamptz not null default now(),
  last_enriched_at timestamptz not null default now()
);

create index if not exists enrichment_profiles_last_enriched_idx
  on public.enrichment_profiles (last_enriched_at desc);

alter table public.enrichment_profiles enable row level security;
revoke all on table public.enrichment_profiles from anon, authenticated;
grant all on table public.enrichment_profiles to service_role;

-- v28: persistent LinkedIn searches and independent company research records.
create table if not exists public.person_searches (
  normalized_url text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.contact_research (
  search_result_id text primary key,
  normalized_url text not null references public.person_searches(normalized_url),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists contact_research_person_idx on public.contact_research(normalized_url);
alter table public.person_searches enable row level security;
alter table public.contact_research enable row level security;
revoke all on table public.person_searches, public.contact_research from anon, authenticated;
grant all on table public.person_searches, public.contact_research to service_role;
