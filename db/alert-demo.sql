-- Additive prepared-fix demo. Existing hosted repair and reminder state remain intact.
begin;
create table errand.alert_demo (
 id uuid primary key default gen_random_uuid(),
 base_sha text not null check(base_sha ~ '^[a-f0-9]{40}$'),
 receipt text unique check(receipt ~ '^[a-f0-9]{32}$'),
 phase text not null default 'waiting' check(phase in ('waiting','queued','opening_pr','calling','completed','failed','unknown')),
 pr text check(pr ~ '^https://github[.]com/Jishan97/errand-agent-demo/pull/[1-9][0-9]*$'),
 expires_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
alter table errand.alert_demo enable row level security;
revoke all on errand.alert_demo from public,anon,authenticated;
grant select,insert,update on errand.alert_demo to service_role;

create function public.errand_alert_arm(p_base_sha text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r errand.alert_demo;
begin
 if coalesce(p_base_sha,'') !~ '^[a-f0-9]{40}$' then raise exception 'invalid_revision'; end if;
 perform pg_advisory_xact_lock(hashtextextended('errand_alert_demo',0));
 if exists(select 1 from errand.alert_demo where phase in ('queued','opening_pr','calling','unknown')) then raise exception 'alert_needs_reconciliation'; end if;
 if exists(select 1 from errand.alert_demo where base_sha=p_base_sha and receipt is not null) then raise exception 'revision_already_used'; end if;
 select * into r from errand.alert_demo where base_sha=p_base_sha and phase='waiting' and expires_at>clock_timestamp() order by created_at desc limit 1;
 if not found then
  update errand.alert_demo set expires_at=clock_timestamp() where phase='waiting';
  insert into errand.alert_demo(base_sha) values(p_base_sha) returning * into r;
 end if;
 return jsonb_build_object('status','approved','baseSha',r.base_sha,'expiresAt',r.expires_at);
end; $$;

create function public.errand_alert_accept(p_receipt text,p_base_sha text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r errand.alert_demo;
begin
 if coalesce(p_receipt,'') !~ '^[a-f0-9]{32}$' or coalesce(p_base_sha,'') !~ '^[a-f0-9]{40}$' then raise exception 'invalid_alert'; end if;
 perform pg_advisory_xact_lock(hashtextextended('errand_alert_demo',0));
 select * into r from errand.alert_demo where receipt=p_receipt;
 if found then return jsonb_build_object('status','duplicate'); end if;
 select * into r from errand.alert_demo where base_sha=p_base_sha and phase='waiting' and expires_at>clock_timestamp() order by created_at desc limit 1 for update;
 if not found then return jsonb_build_object('status','unarmed'); end if;
 update errand.alert_demo set receipt=p_receipt,phase='queued',updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('status','queued');
end; $$;

create function public.errand_alert_claim(p_receipt text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r errand.alert_demo;
begin
 update errand.alert_demo set phase='opening_pr',updated_at=clock_timestamp() where receipt=p_receipt and phase='queued' returning * into r;
 if not found then return jsonb_build_object('status','not_claimed'); end if;
 return jsonb_build_object('status','claimed','baseSha',r.base_sha,'approvalId',r.id);
end; $$;

create function public.errand_alert_record(p_receipt text,p_phase text,p_pr text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r errand.alert_demo;
begin
 select * into r from errand.alert_demo where receipt=p_receipt for update;
 if not found or not ((r.phase='opening_pr' and p_phase in ('calling','failed','unknown')) or (r.phase='calling' and p_phase in ('completed','unknown'))) then raise exception 'invalid_alert_transition'; end if;
 if p_phase in ('calling','completed') and coalesce(p_pr,'') !~ '^https://github[.]com/Jishan97/errand-agent-demo/pull/[1-9][0-9]*$' then raise exception 'pr_required'; end if;
 if r.pr is not null and p_pr is distinct from r.pr then raise exception 'pr_changed'; end if;
 update errand.alert_demo set phase=p_phase,pr=p_pr,updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('status','recorded');
end; $$;

create function public.errand_alert_status() returns jsonb
language sql security invoker set search_path='' as $$
 select coalesce((select jsonb_build_object('status','found','phase',phase,'baseSha',base_sha,'pullRequest',pr,
 'callbackStatus',case when phase='completed' then 'submitted_not_verified' else null end) from errand.alert_demo order by created_at desc limit 1),jsonb_build_object('status','missing'));
$$;
revoke all on function public.errand_alert_arm(text),public.errand_alert_accept(text,text),public.errand_alert_claim(text),public.errand_alert_record(text,text,text),public.errand_alert_status() from public,anon,authenticated;
grant execute on function public.errand_alert_arm(text),public.errand_alert_accept(text,text),public.errand_alert_claim(text),public.errand_alert_record(text,text,text),public.errand_alert_status() to service_role;
commit;
