-- Apply AFTER gmail.sql. Independent additive migration for image generation.
begin;
create table errand.gmail_image_claims (
  task_id uuid not null references errand.gmail_tasks(id), revision integer not null,
  user_id text not null, asset_id text not null, claimed_at timestamptz not null default now(),
  primary key(task_id,revision)
);
alter table errand.gmail_image_claims enable row level security;
revoke all on errand.gmail_image_claims from public,anon,authenticated,service_role;
grant select,insert on errand.gmail_image_claims to service_role;
create function public.errand_gmail_image(p_op text,p_user text,p_args jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t errand.gmail_tasks;
begin
  if p_op is distinct from 'claim' or p_user is null or p_user !~ '^[a-zA-Z0-9_-]{1,200}$'
    or p_args->>'assetId' is null or p_args->>'assetId' !~ '^[a-f0-9]{64}$' then raise exception 'gmail_image_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('errand_gmail:'||p_user,0));
  select * into t from errand.gmail_tasks where id=(p_args->>'taskId')::uuid and user_id=p_user;
  if t.id is null or t.revision is distinct from (p_args->>'revision')::integer or t.proposal_id is not null
    or exists(select 1 from errand.gmail_proposals where user_id=p_user and outcome->>'status' in ('queued','attempting','uncertain','verification_pending')) then return 'false'; end if;
  insert into errand.gmail_image_claims(task_id,revision,user_id,asset_id) values(t.id,t.revision,p_user,p_args->>'assetId')
    on conflict(task_id,revision) do nothing;
  return to_jsonb(found);
end $$;
revoke all on function public.errand_gmail_image(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.errand_gmail_image(text,text,jsonb) to service_role;
commit;
