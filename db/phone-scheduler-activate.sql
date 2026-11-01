-- Run after the phone deployment is READY. Reuses the existing cron job and
-- database-held worker capability. Never return/read its plaintext in a tool.
-- Legacy developer/incident wake-ups retain their existing destination.
create or replace function errand.wake_assistant_worker()
returns void language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from errand.assistant_jobs where operation in ('callback','result_callback') and
    ((status='queued' and due_at<=clock_timestamp()) or (status='claimed' and claimed_at<clock_timestamp()-interval '2 minutes'))) then
    perform net.http_post(url:='https://errand-hackathon-day.vercel.app/api/assistant/worker',
      headers:='{"Content-Type":"application/json"}'::jsonb,
      body:=jsonb_build_object('token',(select decrypted_secret from vault.decrypted_secrets where name='errand_assistant_worker' limit 1)),
      timeout_milliseconds:=15000);
  end if;
  if exists(select 1 from errand.assistant_jobs where operation not in ('callback','result_callback') and
    ((status='queued' and due_at<=clock_timestamp()) or (status='claimed' and claimed_at<clock_timestamp()-interval '2 minutes')))
    or exists(select 1 from errand.incident_demo_jobs where
    (status='queued' and due_at<=clock_timestamp()) or (status='claimed' and claimed_at<clock_timestamp()-interval '2 minutes')) then
    perform net.http_post(url:='https://errand-mvp-jishan97s-projects.vercel.app/api/assistant/worker',
      headers:='{"Content-Type":"application/json"}'::jsonb,
      body:=jsonb_build_object('token',(select decrypted_secret from vault.decrypted_secrets where name='errand_assistant_worker' limit 1)),
      timeout_milliseconds:=15000);
  end if;
end;
$$;
revoke all on function errand.wake_assistant_worker() from public,anon,authenticated,service_role;
