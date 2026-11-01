-- Additive hackathon fast lane. Reuses the existing Supabase project and errand
-- schema; does not modify the prepared phone flow or its scheduler. Apply once
-- in one transaction after reviewing. All RPCs are service-role only.
begin;
create schema if not exists errand;

create function errand.fast_safe_json(p_value jsonb,p_limit integer)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='object' and octet_length(p_value::text)<=p_limit
    and p_value::text !~* '"[^"[:space:]]*(token|secret|password|authorization|cookie|private_?key|credential)[^"[:space:]]*"[[:space:]]*:',false);
$$;

create table errand.fast_approvals (
  id uuid primary key default gen_random_uuid(),
  base_sha text not null check(base_sha ~ '^[a-f0-9]{40}$'),
  scope text not null check(scope='upload-parser-fix-test-pr-merge-replay-callback'),
  expires_at timestamptz not null default clock_timestamp()+interval '10 minutes',
  consumed_receipt text unique check(consumed_receipt ~ '^[a-f0-9]{32}$'),
  created_at timestamptz not null default clock_timestamp()
);
create table errand.fast_runs (
  id text primary key check(id ~ '^[a-f0-9]{32}$'),
  approval_id uuid not null unique references errand.fast_approvals(id),
  event jsonb not null check(errand.fast_safe_json(event,4000)),
  approval jsonb not null check(errand.fast_safe_json(approval,2000)),
  phase text not null check(phase in ('repair_start','repair_poll','cleanup','create_pr','ci_wait','merge','deployment_wait','callback','completed','failed','unknown')),
  state jsonb not null default '{}' check(errand.fast_safe_json(state,160000)),
  lease uuid,claimed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
alter table errand.fast_approvals enable row level security;
alter table errand.fast_runs enable row level security;
revoke all on errand.fast_approvals,errand.fast_runs from public,anon,authenticated,service_role;
grant usage on schema errand to service_role;
grant select,insert,update on errand.fast_approvals,errand.fast_runs to service_role;

create function public.errand_fast_arm(p_base_sha text,p_scope text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a errand.fast_approvals;
begin
  if p_base_sha is null or p_base_sha !~ '^[a-f0-9]{40}$' or p_scope is distinct from 'upload-parser-fix-test-pr-merge-replay-callback' then raise exception 'invalid_fast_approval'; end if;
  perform pg_advisory_xact_lock(hashtextextended('errand_fast_single_demo',0));
  if exists(select 1 from errand.fast_runs where phase not in ('completed','failed','unknown')) then raise exception 'fast_run_active'; end if;
  -- Unknown outcomes need reconciliation, not a new approval that repeats them.
  if exists(select 1 from errand.fast_runs where phase='unknown') then raise exception 'fast_run_needs_reconciliation'; end if;
  -- A failed run may already have a PR or deployment. A stable receipt cannot
  -- restart it; review/reconcile those effects and use a new reviewed revision.
  if exists(select 1 from errand.fast_runs where phase='failed' and event#>>'{details,baseSha}'=p_base_sha) then raise exception 'fast_failed_revision_requires_review'; end if;
  select * into a from errand.fast_approvals where base_sha=p_base_sha and consumed_receipt is null and expires_at>clock_timestamp() order by created_at desc limit 1;
  if not found then
    update errand.fast_approvals set expires_at=clock_timestamp() where consumed_receipt is null and expires_at>clock_timestamp();
    insert into errand.fast_approvals(base_sha,scope) values(p_base_sha,p_scope) returning * into a;
  end if;
  return jsonb_build_object('status','approved','id',a.id,'baseSha',a.base_sha,'scope',a.scope,'expiresAt',a.expires_at);
end;
$$;

create function public.errand_fast_accept(p_event jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a errand.fast_approvals; r errand.fast_runs; receipt text;
begin
  if not errand.fast_safe_json(p_event,4000) or (select count(*) from jsonb_object_keys(p_event))<>4
    or (select count(*) from jsonb_object_keys(p_event) k where k in ('eventId','project','title','details'))<>4
    or coalesce(p_event->>'eventId','') !~ '^[a-f0-9]{32}$' or coalesce(p_event->>'project','') !~ '^[1-9][0-9]{0,19}$'
    or p_event->>'title' is distinct from 'Sample plant upload failed'
    or jsonb_typeof(p_event->'details') is distinct from 'object' or (select count(*) from jsonb_object_keys(p_event->'details'))<>3
    or coalesce(p_event#>>'{details,baseSha}','') !~ '^[a-f0-9]{40}$' or coalesce(p_event#>>'{details,issueId}','') !~ '^[1-9][0-9]{0,19}$'
    or p_event#>>'{details,fixture}' is distinct from 'upload_lf_v1' then raise exception 'invalid_fast_event'; end if;
  receipt:=p_event->>'eventId';
  perform pg_advisory_xact_lock(hashtextextended('errand_fast_single_demo',0));
  select * into r from errand.fast_runs where id=receipt;
  if found then
    if r.event<>p_event then raise exception 'fast_receipt_mismatch'; end if;
    return jsonb_build_object('status','duplicate','receiptId',receipt);
  end if;
  if exists(select 1 from errand.fast_runs where phase not in ('completed','failed')) then return jsonb_build_object('status','unarmed','receiptId',receipt); end if;
  select * into a from errand.fast_approvals where fast_approvals.base_sha=p_event#>>'{details,baseSha}'
    and consumed_receipt is null and expires_at>clock_timestamp() order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('status','unarmed','receiptId',receipt); end if;
  update errand.fast_approvals set consumed_receipt=receipt where id=a.id;
  insert into errand.fast_runs(id,approval_id,event,approval,phase) values(receipt,a.id,p_event,
    jsonb_build_object('id',a.id,'baseSha',a.base_sha,'scope',a.scope,'expiresAt',a.expires_at),'repair_start');
  return jsonb_build_object('status','queued','receiptId',receipt);
end;
$$;

create function public.errand_fast_claim(p_id text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r errand.fast_runs; fresh uuid:=gen_random_uuid();
begin
  if p_id is null or p_id !~ '^[a-f0-9]{32}$' then raise exception 'invalid_fast_receipt'; end if;
  select * into r from errand.fast_runs where id=p_id for update;
  if not found then return jsonb_build_object('status','missing'); end if;
  if r.phase in ('completed','failed','unknown') then return jsonb_build_object('status','terminal','phase',r.phase); end if;
  if r.lease is not null then
    if r.claimed_at>clock_timestamp()-interval '2 minutes' then return jsonb_build_object('status','busy'); end if;
    if r.phase in ('repair_start','create_pr','merge','callback') then
      update errand.fast_runs set phase='unknown',state=state||jsonb_build_object('stoppedAtPhase',r.phase),lease=null,claimed_at=null,updated_at=clock_timestamp() where id=p_id;
      return jsonb_build_object('status','terminal','phase','unknown');
    end if;
  end if;
  update errand.fast_runs set lease=fresh,claimed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id;
  return jsonb_build_object('status','claimed','id',r.id,'phase',r.phase,'state',r.state,'event',r.event,'approval',r.approval,'lease',fresh,'createdAt',r.created_at);
end;
$$;

create function public.errand_fast_advance(p_id text,p_lease uuid,p_phase text,p_state jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r errand.fast_runs; allowed boolean;
begin
  if not errand.fast_safe_json(p_state,160000) then raise exception 'invalid_fast_state'; end if;
  select * into r from errand.fast_runs where id=p_id for update;
  if not found or r.lease is null or r.lease is distinct from p_lease or r.claimed_at<=clock_timestamp()-interval '2 minutes'
    or r.phase in ('completed','failed','unknown') then raise exception 'fast_lease_invalid'; end if;
  allowed:=p_phase in ('failed','unknown') or
    (r.phase='repair_start' and p_phase='repair_poll') or
    (r.phase='repair_poll' and p_phase in ('repair_poll','cleanup')) or
    (r.phase='cleanup' and p_phase in ('cleanup','create_pr')) or
    (r.phase='create_pr' and p_phase='ci_wait') or
    (r.phase='ci_wait' and p_phase in ('ci_wait','merge')) or
    (r.phase='merge' and p_phase='deployment_wait') or
    (r.phase='deployment_wait' and p_phase in ('deployment_wait','callback')) or
    (r.phase='callback' and p_phase='completed');
  if not coalesce(allowed,false) then raise exception 'fast_phase_invalid'; end if;
  if p_phase in ('create_pr','ci_wait','merge','deployment_wait','callback','completed') and p_state->'testsPassed' is distinct from 'true'::jsonb then raise exception 'fast_tests_required'; end if;
  if p_phase in ('merge','deployment_wait','callback','completed') and p_state->'ciPassed' is distinct from 'true'::jsonb then raise exception 'fast_ci_required'; end if;
  if p_phase in ('deployment_wait','callback','completed') and coalesce(p_state->>'mergeCommit','') !~ '^[a-f0-9]{40}$' then raise exception 'fast_merge_required'; end if;
  if p_phase in ('callback','completed') and (p_state->'deploymentVerified' is distinct from 'true'::jsonb or p_state->'replayVerified' is distinct from 'true'::jsonb
    or p_state->>'mergeCommit' is distinct from p_state->>'deployedCommit') then raise exception 'fast_replay_required'; end if;
  if p_phase='completed' and p_state->>'callbackStatus' is distinct from 'submitted_not_verified' then raise exception 'fast_callback_required'; end if;
  update errand.fast_runs set phase=p_phase,state=p_state,lease=null,claimed_at=null,updated_at=clock_timestamp() where id=p_id;
  return jsonb_build_object('status','recorded','receiptId',p_id,'phase',p_phase);
end;
$$;

create function public.errand_fast_status(p_id text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r errand.fast_runs; result jsonb; pr text;
begin
  if p_id is not null and p_id !~ '^[a-f0-9]{32}$' then raise exception 'invalid_fast_receipt'; end if;
  select * into r from errand.fast_runs where p_id is null or id=p_id order by created_at desc limit 1;
  if not found then return jsonb_build_object('status','missing'); end if;
  result:=jsonb_build_object('status','found','receiptId',r.id,'phase',r.phase,'createdAt',r.created_at,'updatedAt',r.updated_at,
    'elapsedMs',floor(extract(epoch from (case when r.phase in ('completed','failed','unknown') then r.updated_at else clock_timestamp() end-r.created_at))*1000),
    'testsPassed',coalesce(r.state->'testsPassed'='true'::jsonb,false),'ciPassed',coalesce(r.state->'ciPassed'='true'::jsonb,false),'replayVerified',coalesce(r.state->'replayVerified'='true'::jsonb,false));
  pr:=r.state#>>'{pr,pullRequest}';
  if pr ~ '^https://github[.]com/Jishan97/errand-agent-demo/pull/[1-9][0-9]*$' then result:=result||jsonb_build_object('pullRequest',pr); end if;
  if r.state->>'mergeCommit' ~ '^[a-f0-9]{40}$' then result:=result||jsonb_build_object('mergeCommit',r.state->>'mergeCommit'); end if;
  if r.state->>'callbackStatus' in ('submitted_not_verified','unknown') then result:=result||jsonb_build_object('callbackStatus',r.state->>'callbackStatus'); end if;
  if r.state->>'stoppedAtPhase' in ('repair_start','repair_poll','cleanup','create_pr','ci_wait','merge','deployment_wait','callback') then result:=result||jsonb_build_object('stoppedAtPhase',r.state->>'stoppedAtPhase'); end if;
  if jsonb_typeof(r.state->'cleanupVerified')='boolean' then result:=result||jsonb_build_object('cleanupVerified',r.state->'cleanupVerified'); end if;
  return result;
end;
$$;

revoke all on function errand.fast_safe_json(jsonb,integer) from public,anon,authenticated;
grant execute on function errand.fast_safe_json(jsonb,integer) to service_role;
revoke all on function public.errand_fast_arm(text,text),public.errand_fast_accept(jsonb),public.errand_fast_claim(text),public.errand_fast_advance(text,uuid,text,jsonb),public.errand_fast_status(text) from public,anon,authenticated;
grant execute on function public.errand_fast_arm(text,text),public.errand_fast_accept(jsonb),public.errand_fast_claim(text),public.errand_fast_advance(text,uuid,text,jsonb),public.errand_fast_status(text) to service_role;
commit;
