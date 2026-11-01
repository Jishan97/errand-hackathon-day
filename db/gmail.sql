-- Additive Gmail operator demo. Apply once, separately from fast-incident.sql.
-- Only the server's existing Supabase service role can call this RPC.
begin;
create schema if not exists errand;
create table errand.gmail_records (
  user_id text not null, kind text not null check (kind in ('binding','attempt','asset')),
  id text not null, value jsonb not null, primary key(user_id,kind,id)
);
create table errand.gmail_tasks (
  id uuid primary key, user_id text not null, revision integer not null default 1,
  proposal_id uuid
);
create table errand.gmail_proposals (
  id uuid primary key, user_id text not null, task_id uuid not null references errand.gmail_tasks(id),
  revision integer not null, value jsonb not null,
  approval jsonb, approved_until timestamptz, claimed_at timestamptz, worker_finished boolean not null default false,
  outcome jsonb, unique(task_id,revision)
);
alter table errand.gmail_records enable row level security;
alter table errand.gmail_tasks enable row level security;
alter table errand.gmail_proposals enable row level security;
revoke all on errand.gmail_records,errand.gmail_tasks,errand.gmail_proposals from public,anon,authenticated,service_role;
grant usage on schema errand to service_role;
grant select,insert,update,delete on errand.gmail_records,errand.gmail_tasks,errand.gmail_proposals to service_role;

create function public.errand_gmail(p_op text,p_user text,p_args jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v jsonb; b jsonb; a jsonb; t errand.gmail_tasks; p errand.gmail_proposals;
begin
  if p_user is null or p_user !~ '^[a-zA-Z0-9_-]{1,200}$' or jsonb_typeof(p_args) is distinct from 'object'
    or octet_length(p_args::text)>20971520 then raise exception 'gmail_invalid'; end if;
  -- Serializes per-user approval, reconnect, task creation and one-use claims.
  perform pg_advisory_xact_lock(hashtextextended('errand_gmail:'||p_user,0));
  if p_op='get_binding' then
    select value into v from errand.gmail_records where user_id=p_user and kind='binding' and id='current'; return v;
  elsif p_op='put_attempt' then
    v:=p_args->'value';
    if v->>'userId' is distinct from p_user or length(v->>'sessionId') not between 1 and 200 then raise exception 'gmail_invalid'; end if;
    insert into errand.gmail_records values(p_user,'attempt',v->>'sessionId',v)
      on conflict(user_id,kind,id) do update set value=excluded.value; return 'true';
  elsif p_op='get_attempt' then
    select value into v from errand.gmail_records where user_id=p_user and kind='attempt' and id=p_args->>'sessionId'; return v;
  elsif p_op='finish_attempt' then
    a:=p_args->'attempt'; b:=p_args->'binding';
    select value into v from errand.gmail_records where user_id=p_user and kind='attempt' and id=a->>'sessionId';
    if v is distinct from a or a->>'userId' is distinct from p_user or b->>'userId' is distinct from p_user
      or a->>'accountId' is distinct from b->>'accountId' or (a->>'expiresAt')::numeric<=extract(epoch from clock_timestamp())*1000 then return 'false'; end if;
    delete from errand.gmail_records where user_id=p_user and kind='attempt' and id=a->>'sessionId';
    insert into errand.gmail_records values(p_user,'binding','current',b)
      on conflict(user_id,kind,id) do update set value=excluded.value; return 'true';
  elsif p_op='new_task' then
    select id,outcome into p.id,p.outcome from errand.gmail_proposals where user_id=p_user and outcome->>'status' in ('queued','attempting','uncertain','verification_pending') limit 1;
    if found then return jsonb_build_object('status','unresolved','proposalId',p.id); end if;
    insert into errand.gmail_tasks(id,user_id) values((p_args->>'id')::uuid,p_user) returning * into t;
    return jsonb_build_object('userId',p_user,'taskId',t.id,'revision',t.revision);
  elsif p_op='get_task' then
    select * into t from errand.gmail_tasks where id=(p_args->>'id')::uuid and user_id=p_user;
    if not found then return null; end if;
    return jsonb_build_object('userId',p_user,'taskId',t.id,'revision',t.revision);
  elsif p_op='revise_task' then
    select * into t from errand.gmail_tasks where id=(p_args->>'id')::uuid and user_id=p_user;
    if not found then return null; end if;
    select id,outcome into p.id,p.outcome from errand.gmail_proposals where user_id=p_user and outcome->>'status' in ('queued','attempting','uncertain','verification_pending') limit 1;
    if found then return jsonb_build_object('status','unresolved','proposalId',p.id); end if;
    update errand.gmail_proposals set approval=null,outcome='{"status":"rejected","reason":"superseded"}'
      where id=t.proposal_id and claimed_at is null;
    update errand.gmail_tasks set revision=revision+1,proposal_id=null where id=t.id returning * into t;
    return jsonb_build_object('userId',p_user,'taskId',t.id,'revision',t.revision);
  elsif p_op='put_proposal' then
    v:=p_args->'value';
    select * into t from errand.gmail_tasks where id=(v->>'taskId')::uuid and user_id=p_user;
    select value into b from errand.gmail_records where user_id=p_user and kind='binding' and id='current';
    if t.id is null or t.proposal_id is not null or t.revision is distinct from (v->>'revision')::integer
      or v->>'userId' is distinct from p_user or b->>'bindingId' is distinct from v->>'bindingId'
      or b->>'accountId' is distinct from v->>'accountId'
      or exists(select 1 from errand.gmail_proposals where user_id=p_user and outcome->>'status' in ('queued','attempting','uncertain','verification_pending')) then return 'false'; end if;
    insert into errand.gmail_proposals(id,user_id,task_id,revision,value) values((v->>'id')::uuid,p_user,t.id,t.revision,v);
    update errand.gmail_tasks set proposal_id=(v->>'id')::uuid where id=t.id;
    return 'true';
  elsif p_op='get_asset' then
    select value into v from errand.gmail_records where user_id=p_user and kind='asset' and id=p_args->>'id'
      and value->>'taskId'=p_args->>'taskId'; return v;
  elsif p_op='put_asset' then
    v:=p_args->'value';
    if v->>'userId' is distinct from p_user or not exists(select 1 from errand.gmail_tasks where id=(v->>'taskId')::uuid and user_id=p_user)
      or v->>'assetId' is null or length(v->>'data')>6990508 then raise exception 'gmail_invalid'; end if;
    insert into errand.gmail_records values(p_user,'asset',v->>'assetId',v); return 'true';
  elsif p_op='pending' then
    select coalesce(jsonb_agg(jsonb_build_object('proposalId',id,'taskId',task_id,'status',outcome->>'status')),'[]') into v
      from errand.gmail_proposals where user_id=p_user and outcome->>'status' in ('queued','attempting','uncertain','verification_pending');
    return v;
  end if;

  select * into p from errand.gmail_proposals where id=(p_args->>'id')::uuid and user_id=p_user;
  if p.id is null then return null; end if;
  if p_op='get_proposal' then return p.value;
  elsif p_op='get_outcome' then return p.outcome;
  elsif p_op='approve' or p_op='claim' then
    v:=p_args->'scope';
    select value into b from errand.gmail_records where user_id=p_user and kind='binding' and id='current';
    select * into t from errand.gmail_tasks where id=p.task_id;
    a:=jsonb_build_object('userId',p_user,'taskId',p.task_id,'revision',p.revision,'proposalId',p.id,
      'action',p.value->>'action','accountId',p.value->>'accountId','bindingId',p.value->>'bindingId','digest',p.value->>'digest');
    if v is distinct from a or t.proposal_id is distinct from p.id or t.revision<>p.revision or p.claimed_at is not null
      or b->>'bindingId' is distinct from p.value->>'bindingId' or b->>'accountId' is distinct from p.value->>'accountId' then return 'false'; end if;
    if p_op='approve' then
      if p.outcome is not null or exists(select 1 from errand.gmail_proposals where user_id=p_user and id<>p.id
        and outcome->>'status' in ('queued','attempting','uncertain','verification_pending')) then return 'false'; end if;
      update errand.gmail_proposals set approval=v,approved_until=clock_timestamp()+interval '10 minutes',outcome='{"status":"queued"}' where id=p.id;
    else
      if p.approval is distinct from v or p.outcome->>'status' is distinct from 'queued' then return 'false'; end if;
      if p.approved_until<=clock_timestamp() then
        update errand.gmail_proposals set outcome='{"status":"rejected","reason":"approval_expired"}' where id=p.id; return 'false';
      end if;
      update errand.gmail_proposals set claimed_at=clock_timestamp(),outcome='{"status":"attempting"}' where id=p.id;
    end if; return 'true';
  elsif p_op='cancel' then
    if p.claimed_at is not null then return 'false'; end if;
    update errand.gmail_proposals set approval=null,outcome='{"status":"rejected","reason":"cancelled"}' where id=p.id; return 'true';
  elsif p_op='finish_worker' then
    if p.claimed_at is not null then update errand.gmail_proposals set worker_finished=true where id=p.id; end if; return 'true';
  elsif p_op='can_reconcile' then
    return to_jsonb(p.claimed_at is not null and p.approval=p_args->'scope'
      and (p.worker_finished or p.claimed_at<clock_timestamp()-interval '5 minutes'));
  elsif p_op='close_manual' then
    if p.claimed_at is null or p.outcome->>'status' not in ('attempting','uncertain','verification_pending')
      or not (p.worker_finished or p.claimed_at<clock_timestamp()-interval '5 minutes')
      or p.value->>'digest' is distinct from p_args->>'digest'
      or p_args->>'acknowledgement' is distinct from 'reviewed_mailbox_may_have_been_sent' then return 'false'; end if;
    update errand.gmail_proposals set outcome=jsonb_build_object('status','manual_review_closed','actor',p_user,
      'closedAt',clock_timestamp(),'mayHaveBeenDelivered',true) where id=p.id;
    return 'true';
  elsif p_op='record_outcome' then
    v:=p_args->'value';
    if p.claimed_at is null or jsonb_typeof(v) is distinct from 'object' or octet_length(v::text)>4096
      or v->>'status' is null or v->>'status' not in ('verified','rejected','verification_pending','uncertain') then raise exception 'gmail_invalid'; end if;
    if p.outcome->>'status' not in ('verified','rejected','manual_review_closed') then
      update errand.gmail_proposals set outcome=v where id=p.id;
    end if; return 'true';
  end if;
  raise exception 'gmail_operation_invalid';
end;
$$;
revoke all on function public.errand_gmail(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.errand_gmail(text,text,jsonb) to service_role;
commit;
