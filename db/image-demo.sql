-- Additive, private storage for the controlled phone-to-screen demonstration.
-- Owner applies once to the existing Supabase project before enabling phone images.
begin;
create table if not exists public.errand_image_runs (
  id uuid primary key,
  call_hash text not null check (call_hash ~ '^[a-f0-9]{64}$'),
  nonce uuid not null,
  hash text not null check (hash ~ '^[a-f0-9]{64}$'),
  summary text not null check (length(summary) between 1 and 600),
  prompt text not null check (length(prompt) between 1 and 160),
  status text not null check (status in ('proposed','running','ready','failed','uncertain','declined')),
  image_base64 text check (length(image_base64) <= 4194304),
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  check ((status = 'ready') = (image_base64 is not null))
);
alter table public.errand_image_runs enable row level security;
revoke all on public.errand_image_runs from public, anon, authenticated;
grant select, insert, update, delete on public.errand_image_runs to service_role;
create index if not exists errand_image_runs_created on public.errand_image_runs(created_at desc);
commit;
