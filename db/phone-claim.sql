-- Callback-only adapter over existing MVP tables; no table, token or schedule creation.
create or replace function public.errand_phone_claim(p_worker_token text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j errand.assistant_jobs; t errand.assistant_tasks; expired_task uuid; lease uuid:=gen_random_uuid();
begin
  if p_worker_token is not null and not exists(select 1 from errand.assistant_worker_auth where token_hash=encode(extensions.digest(p_worker_token,'sha256'),'hex')) then raise exception 'worker_unauthorized'; end if;
  -- Every worker/cancel path locks task before job. Expired effects are unknown,
  -- not retried, because the external action may already have happened.
  for expired_task in select x.id from errand.assistant_tasks x join errand.assistant_jobs y on y.task_id=x.id
    where y.operation in ('callback','result_callback') and y.status='claimed' and y.claimed_at<clock_timestamp()-interval '2 minutes'
    for update of x skip locked limit 10 loop
    update errand.assistant_jobs set status='unknown' where task_id=expired_task and operation in ('callback','result_callback') and status='claimed' and claimed_at<clock_timestamp()-interval '2 minutes';
    update errand.assistant_tasks set status='unknown',updated_at=clock_timestamp() where id=expired_task;
  end loop;
  select x.* into t from errand.assistant_tasks x join errand.assistant_jobs y on y.task_id=x.id
    where y.operation in ('callback','result_callback') and y.status='queued' and y.due_at<=clock_timestamp() order by y.due_at,y.created_at
    for update of x skip locked limit 1;
  if not found then return jsonb_build_object('status','empty'); end if;
  select * into j from errand.assistant_jobs where task_id=t.id and operation in ('callback','result_callback') and status='queued' and due_at<=clock_timestamp()
    order by due_at,created_at for update skip locked limit 1;
  if not found then return jsonb_build_object('status','empty'); end if;
  if t.revision<>j.revision or t.status in ('cancelled','failed','unknown') then
    update errand.assistant_jobs set status='cancelled' where id=j.id;
    return jsonb_build_object('status','ignored');
  end if;
  update errand.assistant_jobs set status='claimed',lease_token=lease,claimed_at=clock_timestamp() where id=j.id;
  if j.operation not in ('callback','result_callback') then update errand.assistant_tasks set status='running',updated_at=clock_timestamp() where id=j.task_id; end if;
  return jsonb_build_object('status','claimed','id',j.id,'taskId',j.task_id,'residentId',j.resident_id,'operation',j.operation,'args',j.arguments,'lease',lease,'revision',j.revision);
end;
$$;


revoke all on function public.errand_phone_claim(text) from public,anon,authenticated;
grant execute on function public.errand_phone_claim(text) to service_role;
