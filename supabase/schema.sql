-- Boxpace private business data. Run this once in Supabase: SQL Editor -> paste -> Run.
-- The Cloudflare functions reach this table with the Supabase secret key; browsers can never read it.

create table if not exists public.boxpace_records (
  namespace text not null,
  record_key text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (namespace, record_key)
);

alter table public.boxpace_records enable row level security;
revoke all on table public.boxpace_records from anon, authenticated;
grant all on table public.boxpace_records to service_role;

create index if not exists boxpace_records_updated_at_idx
  on public.boxpace_records (updated_at desc);

-- Public bucket for approved property photos (the Desk uploads them through the functions).
-- Public means anyone with a photo's link can view it, which is what a public listing needs.
insert into storage.buckets (id, name, public)
values ('property-photos', 'property-photos', true)
on conflict (id) do update set public = true;
