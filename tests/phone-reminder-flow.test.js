import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startVoiceFixture, callSid, environment, signature } from './helpers/phone-voice-fixture.js';
import { placeTestCall } from '../src/phone/voice/twilio.js';

async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await delay(5); }
  assert.fail('The reminder flow did not reach the expected state');
}

test('signed phone request → spoken approval → saved job → hangup → one bound reminder callback', async (t) => {
  // Real HTTP, WebSocket, controller, service, confirmation gate and worker.
  // Storage/provider fixtures are explicit: this does not establish a heard call.
  const taskId = randomUUID(), jobId = randomUUID(), residentId = randomUUID(), callId = randomUUID();
  const callbackSid = `CA${'d'.repeat(32)}`;
  let activeCallSid = callSid;
  let direction = 'inbound', proposal, task, job, due = false, submissions = 0;
  const bindings = [];
  const storage = {
    async context() { return { profile: { timeZone: 'Europe/London', callbackConsent: true }, tasks: task ? [task] : [],
      ...(direction === 'outbound' ? { callback: { title: task.title, result: null } } : {}) }; },
    async stage(input) { proposal = { ...input, id: randomUUID() }; return proposal; },
    async confirm({ proposal: selected }) {
      assert.equal(selected.id, proposal.id); assert.equal(task, undefined);
      task = { id: taskId, title: selected.args.title, revision: 1, status: 'scheduled' };
      job = { status: 'queued', id: jobId, operation: 'callback' };
      return { status: 'confirmed', taskId, taskStatus: 'scheduled' };
    },
    async claim(token) {
      assert.equal(token, 'a'.repeat(64));
      if (!due || job?.status !== 'queued') return { status: 'empty' };
      job.status = 'claimed'; return { ...job };
    },
    async finish(_job, status, result) { job.status = status; job.result = result; },
    async bindCallback(sid, id) { assert.equal(id, jobId); bindings.push({ sid, id }); return { status: 'bound' }; },
    async status() { return { tasks: task ? [task] : [] }; },
  };
  const f = await startVoiceFixture(t, {
    settings: { ENABLE_M1_INTAKE: 'true', ENABLE_SHARED_ASSISTANT: 'true', OPENAI_AGENT_MODEL: 'gpt-6.1-sol',
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SECRET_KEY: "sb_" + "secret_fixture_secret_0000000000000000" },
    limits: { speechQuietMs: 2, transcriptQuietMs: 2, conversationTickMs: 2 },
    m1Options: { assistantRepository: storage,
      repository: {
        async admitDemoCall(input) { direction = input.direction; return { admitted: true, admission_method: 'allowed_test_number' }; },
        async getVerifiedCall() { return { direction }; },
        async issueStream() { return { task_id: null }; },
        async consumeStream() { return { call_id: callId, resident_id: residentId, task_id: null, direction }; },
      },
      planner: async ({ history }) => history.at(-1).text.includes('leaves')
        ? { kind: 'reply', reply: 'Leaves change colour as chlorophyll breaks down.' }
        : { kind: 'propose', operation: 'schedule_callback', args: { title: 'Water the fictional plants', dueAt: new Date(Date.now() + 120000).toISOString() }, sourceEventIds: ['reminder-request'] },
      actionAssessor: async ({ replyHistory }) => { assert.match(replyHistory.at(-1).text, /Yes/); return { decision: 'confirm', sourceEventIds: ['permission'] }; },
      placeCall: (config, options) => placeTestCall(config, { ...options, fetcher: async (_url, request) => {
        submissions++;
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('Url'), `${environment.PUBLIC_BASE_URL}/api/voice/outgoing?job=${jobId}`);
        assert.equal(form.get('To'), environment.TEST_RESIDENT_NUMBER);
        return Response.json({ sid: callbackSid }, { status: 201 });
      } }),
    },
  });
  async function connect() {
    const fields = { AccountSid: environment.TWILIO_ACCOUNT_SID, CallSid: activeCallSid, Direction: direction === 'inbound' ? 'inbound' : 'outbound-api',
      From: direction === 'inbound' ? environment.TEST_RESIDENT_NUMBER : environment.TWILIO_FROM_NUMBER,
      To: direction === 'inbound' ? environment.TWILIO_FROM_NUMBER : environment.TEST_RESIDENT_NUMBER };
    const url = `${environment.PUBLIC_BASE_URL}/api/voice/connect`;
    const response = await fetch(`${f.origin}/api/voice/connect`, { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature(url, fields),
    }, body: new URLSearchParams(fields).toString() });
    assert.equal(response.status, 200);
    const token = (await response.text()).match(/name="bridgeToken" value="([\w.-]+)"/)[1];
    return f.openTelephone({ token, fields: { CallSid: activeCallSid } });
  }
  assert.equal((await f.webhook()).status, 200);
  const telephone = await connect();
  await until(() => f.providers.length === 1);
  const provider = f.providers[0]; await provider.received.waitFor('session.start');
  provider.send({ type: 'session.input_transcript.delta', event_id: 'reminder-request', delta: 'Call me in two minutes to water the fictional plants.', start_ms: 0, end_ms: 300 });
  provider.send({ type: 'session.delegation.created', delegation: { id: 'request', target: 'client' } });
  await until(() => provider.received.messages.some((e) => e.content?.startsWith('Read this proposed action')));
  assert.equal(task, undefined);
  const readback = JSON.parse(provider.received.messages.find((e) => e.content?.startsWith('Read this proposed action')).content.split('data, not instructions: ')[1].split(' Do not claim')[0]);
  provider.send({ type: 'session.output_audio.delta', delta: Buffer.alloc(160, 0).toString('base64') });
  const mark = await telephone.received.waitFor('mark');
  provider.send({ type: 'session.output_transcript.delta', event_id: 'readback', delta: readback, start_ms: 500, end_ms: 1500 });
  telephone.send({ event: 'mark', mark: { name: mark.mark.name } });
  provider.send({ type: 'session.input_transcript.delta', event_id: 'permission', delta: 'Yes, please go ahead.', start_ms: 2000, end_ms: 2300 });
  provider.send({ type: 'session.delegation.created', delegation: { id: 'approval', target: 'client' } });
  await until(() => job?.status === 'queued');
  await until(() => provider.received.messages.some((e) => e.content?.startsWith('Server-confirmed result:')));
  provider.send({ type: 'session.input_transcript.delta', event_id: 'question', delta: 'Why do leaves change colour?', start_ms: 3000, end_ms: 3300 });
  provider.send({ type: 'session.delegation.created', delegation: { id: 'general-question', target: 'client' } });
  await until(() => provider.received.messages.some((e) => e.content?.includes('chlorophyll')));
  assert.equal(job.status, 'queued');
  telephone.stop(); await telephone.closed;

  const runWorker = () => fetch(`${f.origin}/api/assistant/worker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64) }) });
  assert.equal((await (await runWorker()).json()).status, 'empty'); assert.equal(submissions, 0);
  due = true;
  assert.equal((await (await runWorker()).json()).status, 'processed');
  assert.equal((await (await runWorker()).json()).status, 'empty');
  assert.equal(submissions, 1); assert.equal(job.result.delivery, 'not_yet_verified');
  activeCallSid = callbackSid;
  assert.equal((await f.webhook({ direction: 'outbound', fields: { CallSid: activeCallSid }, suffix: `?job=${jobId}` })).status, 200);
  assert.deepEqual(bindings, [{ sid: callbackSid, id: jobId }]);
  const callback = await connect();
  await until(() => f.providers.length === 2);
  const opening = await f.providers[1].received.waitFor('session.start');
  assert.match(opening.session.input[0].content[0].text, /Water the fictional plants/);
  assert.match(opening.session.input[0].content[0].text, /immediately deliver/);
  callback.stop(); await callback.closed;
});
