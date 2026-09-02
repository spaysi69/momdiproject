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


-- Company-specific enrichment cache. This prevents re-consuming a provider
-- credit when the same person at the same company was already enriched, while
-- allowing the same person to have separate records for different companies.
create table if not exists public.enrichment_person_companies (
  id bigint generated always as identity primary key,
  normalized_url text not null,
  company_key text not null,
  profile jsonb not null,
  first_enriched_at timestamptz not null default now(),
  last_enriched_at timestamptz not null default now(),
  unique (normalized_url, company_key)
);

create index if not exists enrichment_person_companies_lookup_idx
  on public.enrichment_person_companies (normalized_url, company_key);

alter table public.enrichment_person_companies enable row level security;
revoke all on table public.enrichment_person_companies from anon, authenticated;
grant all on table public.enrichment_person_companies to service_role;
