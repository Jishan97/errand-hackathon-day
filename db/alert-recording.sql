-- Explicitly authorized, capped recording takes. No automatic PR duplication.
begin;
alter table errand.alert_demo add column reuse_pr boolean not null default false;
alter table errand.alert_demo add column pr_head text check(pr_head ~ '^[a-f0-9]{40}$');
create table errand.alert_recordings (
 base_sha text primary key check(base_sha ~ '^[a-f0-9]{40}$'),
 pr text not null check(pr ~ '^https://github[.]com/Jishan97/errand-agent-demo/pull/[1-9][0-9]*$'),
 pr_head text not null check(pr_head ~ '^[a-f0-9]{40}$'),
 remaining integer not null check(remaining between 0 and 3),
 enabled_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '15 minutes',
 last_accepted_at timestamptz,
 check(expires_at>enabled_at and expires_at<=enabled_at+interval '16 minutes')
);
alter table errand.alert_recordings enable row level security;
revoke all on errand.alert_recordings from public,anon,authenticated;
grant select,insert,update on errand.alert_recordings to service_role;

create function public.errand_alert_accept_capture(p_receipt text,p_base_sha text,p_occurred_at timestamptz) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r errand.alert_demo; b errand.alert_recordings;
begin
 if coalesce(p_receipt,'') !~ '^[a-f0-9]{32}$' or coalesce(p_base_sha,'') !~ '^[a-f0-9]{40}$' or p_occurred_at is null then raise exception 'invalid_alert'; end if;
 perform pg_advisory_xact_lock(hashtextextended('errand_alert_demo',0));
 if exists(select 1 from errand.alert_demo where receipt=p_receipt) then return jsonb_build_object('status','duplicate'); end if;
 if p_occurred_at>clock_timestamp()+interval '1 minute' then return jsonb_build_object('status','unarmed'); end if;
 select * into r from errand.alert_demo where base_sha=p_base_sha and phase='waiting' and expires_at>clock_timestamp() and created_at<=p_occurred_at order by created_at desc limit 1 for update;
 if found then
  update errand.alert_demo set receipt=p_receipt,phase='queued',updated_at=clock_timestamp() where id=r.id;
  return jsonb_build_object('status','queued');
 end if;
 select * into b from errand.alert_recordings where base_sha=p_base_sha and remaining>0 and expires_at>clock_timestamp() and enabled_at<=p_occurred_at for update;
 if not found or (b.last_accepted_at is not null and b.last_accepted_at>clock_timestamp()-interval '60 seconds') then return jsonb_build_object('status','unarmed'); end if;
 if exists(select 1 from errand.alert_demo where phase in ('queued','opening_pr','calling','unknown')) then return jsonb_build_object('status','unarmed'); end if;
 update errand.alert_recordings set remaining=remaining-1,last_accepted_at=clock_timestamp() where base_sha=p_base_sha;
 insert into errand.alert_demo(base_sha,receipt,phase,pr,reuse_pr,pr_head) values(p_base_sha,p_receipt,'queued',b.pr,true,b.pr_head);
 return jsonb_build_object('status','queued');
end; $$;

create or replace function public.errand_alert_claim(p_receipt text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r errand.alert_demo;
begin
 update errand.alert_demo set phase='opening_pr',updated_at=clock_timestamp() where receipt=p_receipt and phase='queued' returning * into r;
 if not found then return jsonb_build_object('status','not_claimed'); end if;
 return jsonb_build_object('status','claimed','baseSha',r.base_sha,'approvalId',r.id,
 'reusePr',case when r.reuse_pr then r.pr else null end,'prHead',r.pr_head);
end; $$;
revoke all on function public.errand_alert_accept_capture(text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.errand_alert_accept_capture(text,text,timestamptz) to service_role;
commit;
