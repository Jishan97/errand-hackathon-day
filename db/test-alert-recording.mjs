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
 await db.query('insert into errand.alert_recordings(base_sha,pr,pr_head,remaining) values($1,$2,$3,10)',[sha,pr,head]);
 await assert.rejects(db.exec('update errand.alert_recordings set remaining=11'),/check constraint/);
 await assert.rejects(db.exec("update errand.alert_recordings set expires_at=enabled_at+interval '62 minutes'"),/check constraint/);
 const window=(await db.query('select extract(epoch from (expires_at-enabled_at)) as seconds from errand.alert_recordings')).rows[0];
 assert.ok(Number(window.seconds)>=3600 && Number(window.seconds)<3660);
 const accept=async(n,revision=sha,at=new Date().toISOString())=>rpc('accept_capture',[n.toString(16).padStart(32,'0'),revision,at]);
 assert.equal((await accept(1,sha,'2000-01-01T00:00:00Z')).status,'unarmed');
 assert.equal((await accept(1,'e'.repeat(40))).status,'unarmed');
 let activePr=pr,activeHead=head;
 for(let i=1;i<=10;i++){
  assert.equal((await accept(i)).status,'queued');
  assert.equal((await accept(i)).status,'duplicate');
  const id=i.toString(16).padStart(32,'0');
  const job=await rpc('claim',[id]); assert.equal(job.status,'claimed'); assert.equal(job.reusePr,activePr); assert.equal(job.prHead,activeHead);
  if(i===1){
   const nextPr=pr+'4',nextHead='f'.repeat(40);
   await assert.rejects(rpc('replace_pr',[id,activePr,'a'.repeat(40),nextPr,nextHead]),/replacement_not_authorized/);
   assert.equal((await rpc('replace_pr',[id,activePr,activeHead,nextPr,nextHead])).status,'recorded');
   await assert.rejects(rpc('replace_pr',[id,activePr,activeHead,nextPr,nextHead]),/replacement_not_authorized/);
   const budget=(await db.query('select remaining,pr,pr_head from errand.alert_recordings')).rows[0];
   assert.equal(budget.remaining,9); assert.equal(budget.pr,nextPr); assert.equal(budget.pr_head,nextHead);
   activePr=nextPr; activeHead=nextHead;
  }
  assert.equal((await rpc('claim',[id])).status,'not_claimed');
  assert.equal((await accept(10+i)).status,'unarmed');
  await rpc('record',[id,'calling',activePr]); await rpc('record',[id,'completed',activePr]);
  assert.equal((await accept(10+i)).status,'unarmed');
  await db.exec("update errand.alert_recordings set last_accepted_at=clock_timestamp()-interval '61 seconds'");
 }
 assert.equal((await accept(101)).status,'unarmed');
 assert.equal((await db.query('select remaining from errand.alert_recordings')).rows[0].remaining,0);
 await db.exec("update errand.alert_recordings set remaining=1, enabled_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 minute'");
 assert.equal((await accept(102)).status,'unarmed');
 await assert.rejects(rpc('fail',['1'.padStart(32,'0'),false,'pr_changed']),/invalid_alert_transition/);
 const failedId='a'.repeat(32),uncertainId='b'.repeat(32);
 await db.query("insert into errand.alert_demo(base_sha,receipt,phase) values($1,$2,'opening_pr'),($1,$3,'calling')",[sha,failedId,uncertainId]);
 await assert.rejects(rpc('fail',[failedId,false,'raw provider content']),/invalid_failure/);
 await rpc('fail',[failedId,false,'pr_changed']);
 assert.equal((await db.query('select failure_reason from errand.alert_demo where receipt=$1',[failedId])).rows[0].failure_reason,'pr_changed');
 await assert.rejects(rpc('fail',[uncertainId,false,'call_unconfirmed']),/invalid_alert_transition/);
 await rpc('fail',[uncertainId,true,'call_unconfirmed']);
 await db.query("update errand.alert_demo set created_at=created_at-interval '1 second' where receipt=$1",[failedId]);
 assert.equal((await rpc('status')).failureReason,'call_unconfirmed');
 await db.exec('set role anon;'); await assert.rejects(accept(103),/permission denied/);
 await assert.rejects(rpc('fail',[failedId,false,'pr_changed']),/permission denied/);
 await assert.rejects(rpc('replace_pr',[failedId,pr,head,activePr,activeHead]),/permission denied/);
 await db.exec('reset role; set role service_role;'); assert.equal((await accept(103)).status,'unarmed');
 console.log('PASS: ten-take cap, fresh timestamps, revision binding, duplicate receipt, cooldown, single claim, atomic replacement, future PR reuse, safe failure reasons, expiry and role boundaries');
} finally {await db.close();}
