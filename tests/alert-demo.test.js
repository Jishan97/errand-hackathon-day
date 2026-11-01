import test from 'node:test';
import assert from 'node:assert/strict';
import reviewed from './fixtures/reviewed-upload.json' with { type: 'json' };
import { preparedRepair, createAlertDemo, ALERT_SCOPE } from '../src/core/alert-demo.js';
import { createErrorAlertCaller } from '../src/voice/completion-call.js';
import { handleOperator } from '../src/core/operator.js';
const baseSha = 'b'.repeat(40), receipt = 'c'.repeat(32);
const url = 'https://github.com/Jishan97/errand-agent-demo/pull/123';
const snapshot = {baseSha, files: reviewed};

test('prepared patch binds all reviewed source bytes and returns only parser/test', () => {
  assert.deepEqual(preparedRepair(snapshot).map(f => f.path), ['lib/upload-parser.js','tests/upload-parser.test.js']);
  for (let i = 0; i < reviewed.length; i++) {
    const changed = structuredClone(snapshot); changed.files[i].content += ' changed';
    assert.throws(() => preparedRepair(changed), /prepared_source_changed/);
  }
});
function fixture({failure} = {}) {
  let claimed = false;
  const calls = [];
  const rpc = async (name, params) => {
    calls.push([name, params]);
    if (name.endsWith('claim')) { if (claimed) return {status:'not_claimed'}; claimed=true; return {status:'claimed',baseSha,approvalId:'11111111-1111-4111-8111-111111111111'}; }
    return {status:'recorded'};
  };
  const github = { snapshot: async () => snapshot, createPullRequest: async input => {
    calls.push(['pr',input]); if(failure==='pr') throw Error('private provider text'); return {pullRequest:url};
  } };
  const caller = {call: async evidence => {calls.push(['call',evidence]); if(failure==='call') throw Error('private provider text'); return {status:'submitted_not_verified'};}};
  return {demo:createAlertDemo({rpc,github,caller}),calls,github};
}
test('signed job opens prepared PR then sends honest error call exactly once', async () => {
  const f=fixture(); assert.equal((await f.demo.run(receipt)).status,'completed');
  assert.deepEqual(f.calls.filter(c=>['pr','call'].includes(c[0])).map(c=>c[0]),['pr','call']);
  assert.equal(f.calls.find(c=>c[0]==='pr')[1].prepared,true);
  assert.equal(f.calls.find(c=>c[0]==='call')[1].signedAlert,true);
  assert.equal((await f.demo.run(receipt)).status,'not_claimed');
  assert.equal(f.calls.filter(c=>c[0]==='call').length,1);
});
test('uncertain PR or call writes are not retried or represented as success', async () => {
  for (const failure of ['pr','call']) {
    const f=fixture({failure}); assert.equal((await f.demo.run(receipt)).status,'unknown');
    await f.demo.run(receipt);
    assert.equal(f.calls.filter(c=>c[0]==='pr').length,1);
    assert.equal(f.calls.filter(c=>c[0]==='call').length,failure==='pr'?0:1);
    assert.doesNotMatch(JSON.stringify(f.calls),/private provider text/);
  }
});
test('changed source stops before PR and call', async()=>{
  const f=fixture(); f.github.snapshot=async()=>({...snapshot,files:[]});
  assert.equal((await f.demo.run(receipt)).status,'failed');
  assert.equal(f.calls.some(c=>['pr','call'].includes(c[0])),false);
});
test('error call requires signed event and confirmed PR and never claims deployment', async()=>{
  const values={TWILIO_ACCOUNT_SID:`AC${'a'.repeat(32)}`,TWILIO_AUTH_TOKEN:'b'.repeat(32),TWILIO_FROM_NUMBER:'+12025550101',TEST_RESIDENT_NUMBER:'+12025550102'};
  let count=0;
  const caller=createErrorAlertCaller({config:{liveVoiceEnabled:true,values},fetcher:async(endpoint,options)=>{
    count++; const twiml=new URLSearchParams(options.body).get('Twiml');
    assert.match(twiml,/Sentry reported/); assert.match(twiml,/prepared/); assert.match(twiml,/has not been merged or deployed/);
    assert.doesNotMatch(twiml,/bug is fixed/);
    return Response.json({sid:`CA${'c'.repeat(32)}`,account_sid:values.TWILIO_ACCOUNT_SID,from:values.TWILIO_FROM_NUMBER,to:values.TEST_RESIDENT_NUMBER,direction:'outbound-api',status:'queued'},{status:201});
  }});
  await assert.rejects(caller.call({baseSha,pullRequest:url}),/callback_evidence_required/);
  assert.equal(count,0);
  assert.equal((await caller.call({signedAlert:true,baseSha,pullRequest:url})).status,'submitted_not_verified');
  assert.equal(count,1);
});
test('operator authentication and explicit narrow scope protect alert arming',async()=>{
  let calls=0; const token='synthetic_operator_token'.padEnd(40,'x');
  const options={getToken:()=>token,getRuntime:()=>({alertDemo:{arm:async()=>{calls++;return {status:'approved'};}}})};
  const request=(auth,scope)=>new Request('https://example.test/api/incident/arm-alert?action=arm-alert',{method:'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({baseSha,scope})});
  assert.equal((await handleOperator(request('bad',ALERT_SCOPE),options)).status,401);
  assert.equal((await handleOperator(request(token,'upload-parser-fix-test-pr-merge-replay-callback'),options)).status,400);
  assert.equal(calls,0);
  assert.equal((await handleOperator(request(token,ALERT_SCOPE),options)).status,200);
  assert.equal(calls,1);
});
