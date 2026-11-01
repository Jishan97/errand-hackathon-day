// Isolated PostgreSQL tests; explicit temporary PGlite module, no project secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw Error('Pass an explicit PGlite module path');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const claimSql = await readFile(new URL('./phone-claim.sql', import.meta.url), 'utf8');
const schedulerSql = await readFile(new URL('./phone-scheduler-activate.sql', import.meta.url), 'utf8');
async function fixture(run) {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema errand; create schema extensions; create schema net; create schema vault;
      create function extensions.digest(text,text) returns bytea language sql immutable as 'select sha256(convert_to($1,''UTF8''))';
      create table errand.assistant_worker_auth(token_hash text);
      insert into errand.assistant_worker_auth values(encode(extensions.digest('fixture-worker','sha256'),'hex'));
      create table errand.assistant_tasks(id uuid primary key default gen_random_uuid(),resident_id uuid default gen_random_uuid(),revision integer default 1,status text default 'scheduled',updated_at timestamptz default now());
      create table errand.assistant_jobs(id uuid primary key default gen_random_uuid(),task_id uuid,resident_id uuid default gen_random_uuid(),revision integer default 1,operation text default 'callback',arguments jsonb default '{}',due_at timestamptz default now(),created_at timestamptz default now(),status text default 'queued',claimed_at timestamptz,lease_token uuid);
      create table errand.incident_demo_jobs(status text,due_at timestamptz,claimed_at timestamptz);
      create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into vault.decrypted_secrets values('errand_assistant_worker','fixture-worker');
      create table net.requests(url text);
      create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into net.requests values(url); return 1; end$$;`);
    await db.exec(claimSql); await db.exec(schedulerSql);
    const add = async (operation = 'callback', due = '-1 minute') => {
      const task = (await db.query('insert into errand.assistant_tasks default values returning id')).rows[0].id;
      await db.query("insert into errand.assistant_jobs(task_id,operation,due_at) values($1,$2,clock_timestamp()+$3::interval)", [task, operation, due]);
      return task;
    };
    const claim = async (token = 'fixture-worker') => (await db.query('select public.errand_phone_claim($1) as result', [token])).rows[0].result;
    await run(db, add, claim);
  } finally { await db.close(); }
}
test('actual SQL claims only due callbacks, once, leaving developer jobs intact', () => fixture(async (db, add, claim) => {
  await add('developer_check'); await add('callback', '5 minutes'); const due = await add();
  const first = await claim(); assert.equal(first.taskId, due); assert.equal(first.status, 'claimed');
  assert.equal((await claim()).status, 'empty');
  assert.equal((await db.query("select status from errand.assistant_jobs where operation='developer_check'")).rows[0].status, 'queued');
}));
test('expired callback effects become unknown and are never submitted again', () => fixture(async (db, add, claim) => {
  const id = await add(); await claim();
  await db.query("update errand.assistant_jobs set claimed_at=clock_timestamp()-interval '3 minutes'");
  assert.equal((await claim()).status, 'empty');
  assert.equal((await db.query('select status from errand.assistant_tasks where id=$1', [id])).rows[0].status, 'unknown');
}));
test('invalid worker capability cannot claim or mutate a reminder', () => fixture(async (db, add, claim) => {
  await add(); await assert.rejects(claim('wrong-worker'), /worker_unauthorized/);
  assert.equal((await db.query('select status from errand.assistant_jobs')).rows[0].status, 'queued');
}));
test('new claim RPC is service-only and scheduler helper remains private', () => fixture(async (db) => {
  const result = (await db.query("select has_function_privilege('anon','public.errand_phone_claim(text)','execute') as anon,has_function_privilege('authenticated','public.errand_phone_claim(text)','execute') as authenticated,has_function_privilege('service_role','public.errand_phone_claim(text)','execute') as service")).rows[0];
  assert.deepEqual(result, { anon: false, authenticated: false, service: true });
}));
test('existing scheduler sends reminders to hackathon while preserving legacy work destination', () => fixture(async (db, add) => {
  await db.exec('select errand.wake_assistant_worker()'); assert.equal((await db.query('select * from net.requests')).rows.length, 0);
  await add(); await add('developer_check'); await db.exec('select errand.wake_assistant_worker()');
  assert.deepEqual((await db.query('select url from net.requests order by url')).rows.map((r) => r.url), [
    'https://errand-hackathon-day.vercel.app/api/assistant/worker', 'https://errand-mvp-jishan97s-projects.vercel.app/api/assistant/worker',
  ]);
}));
