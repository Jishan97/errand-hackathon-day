import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();
try {
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema errand; grant usage on schema errand to service_role;');
 for(const file of ['alert-demo.sql','alert-recording.sql']) await db.exec(await readFile(new URL(file,import.meta.url),'utf8'));
 const rpc=async(name,args=[]) => (await db.query(`select public.errand_alert_${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const sha='b'.repeat(40),head='d'.repeat(40),pr='https://github.com/Jishan97/errand-agent-demo/pull/123';
 await db.query('insert into errand.alert_recordings(base_sha,pr,pr_head,remaining) values($1,$2,$3,3)',[sha,pr,head]);
 const accept=async(n,revision=sha,at=new Date().toISOString())=>rpc('accept_capture',[n.toString(16).padStart(32,'0'),revision,at]);
 assert.equal((await accept(1,sha,'2000-01-01T00:00:00Z')).status,'unarmed');
 assert.equal((await accept(1,'e'.repeat(40))).status,'unarmed');
 for(let i=1;i<=3;i++){
  assert.equal((await accept(i)).status,'queued');
  assert.equal((await accept(i)).status,'duplicate');
  const id=i.toString(16).padStart(32,'0');
  const job=await rpc('claim',[id]); assert.equal(job.status,'claimed'); assert.equal(job.reusePr,pr); assert.equal(job.prHead,head);
  assert.equal((await rpc('claim',[id])).status,'not_claimed');
  assert.equal((await accept(10+i)).status,'unarmed');
  await rpc('record',[id,'calling',pr]); await rpc('record',[id,'completed',pr]);
  assert.equal((await accept(10+i)).status,'unarmed');
  await db.exec("update errand.alert_recordings set last_accepted_at=clock_timestamp()-interval '61 seconds'");
 }
 assert.equal((await accept(4)).status,'unarmed');
 assert.equal((await db.query('select remaining from errand.alert_recordings')).rows[0].remaining,0);
 await db.exec("update errand.alert_recordings set remaining=1, enabled_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 minute'");
 assert.equal((await accept(5)).status,'unarmed');
 await db.exec('set role anon;'); await assert.rejects(accept(6),/permission denied/);
 await db.exec('reset role; set role service_role;'); assert.equal((await accept(6)).status,'unarmed');
 console.log('PASS: three-take cap, fresh timestamps, revision binding, duplicate receipt, cooldown, single claim, PR reuse, expiry and role boundaries');
} finally {await db.close();}
