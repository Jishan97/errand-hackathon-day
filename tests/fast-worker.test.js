import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createFastWorker, REPAIR_SCOPE } from '../src/core/fast-worker.js';
import { createApp } from '../src/app.js';
import { createCompletionCaller } from '../src/voice/completion-call.js';

const receiptId = 'a'.repeat(32);
const baseSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const approvalId = '00000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-11-01T15:20:00Z');
const proof = { reproduced: true, fixed: true, regressionTestExecuted: true, artifactsVerified: true,
  readOnlyFilesUnchanged: true, afterExitCode: 0, baseSha };
const handle = { sessionId: 'synthetic_session', mode: 'fix', baseSha };
const files = [{ path: 'lib/upload-parser.js', content: 'synthetic parser' }, { path: 'tests/upload-parser.test.js', content: 'synthetic test' }];
const pr = { number: 2, headSha: 'd'.repeat(40), baseSha, pullRequest: 'https://github.com/example/demo/pull/2' };
const readyState = {
  handle: null, evidence: proof, files, testsPassed: true, cleanupVerified: true, ciPassed: true,
  pr, mergeCommit: mergeSha, deployedCommit: mergeSha, deploymentVerified: true, replayVerified: true,
};

function fixture({ id = receiptId, phase = 'repair_start', state = {}, pendingPolls = 0, pendingCleanup = 0, pendingChecks = 0, pendingReplay = 0 } = {}) {
  let time = now;
  let locked = false;
  const events = [], advances = [], logs = [];
  let job = { status: 'claimed', id, phase, state,
    approval: { id: approvalId, baseSha, scope: REPAIR_SCOPE, expiresAt: new Date(now - 1000).toISOString() },
    event: { eventId: id, project: '123', title: 'Sample plant upload failed', details: { baseSha, issueId: '42', fixture: 'upload_lf_v1' } },
    createdAt: new Date(now).toISOString(), lease: '00000000-0000-4000-8000-000000000002' };
  const store = {
    async claim(requestId) {
      assert.equal(requestId, id);
      if (locked) return { status: 'busy' };
      if (['completed', 'failed', 'unknown'].includes(job.phase)) return { status: 'terminal', phase: job.phase };
      locked = true;
      return structuredClone(job);
    },
    async advance(claim, next) {
      assert.equal(claim.id, id);
      assert.equal(locked, true);
      advances.push(structuredClone(next));
      job = { ...job, ...structuredClone(next) };
      locked = false;
    },
  };
  const github = {
    async snapshot(sha) { events.push('snapshot'); assert.equal(sha, baseSha); return { baseSha, files }; },
    async createPullRequest(input) { events.push('pr'); assert.equal(input.taskId, approvalId); assert.equal(input.baseSha, baseSha); assert.deepEqual(input.files, files); return pr; },
    async checks(value) { events.push('ci'); assert.deepEqual(value, pr); return { status: pendingChecks-- > 0 ? 'pending' : 'passed' }; },
    async merge(value) { events.push('merge'); assert.deepEqual(value, pr); return { mergeSha }; },
    async confirmMerged(value, sha) { events.push('confirm_merge'); assert.deepEqual(value, pr); assert.equal(sha, mergeSha); return { status: 'passed' }; },
    async replay(sha) { events.push('replay'); assert.equal(sha, mergeSha); return pendingReplay-- > 0 ? { status: 'pending' } : { status: 'passed', deployedCommit: mergeSha }; },
  };
  const runner = {
    async startApprovedRepair(snapshot, approval) { events.push('repair'); assert.equal(snapshot.baseSha, baseSha); assert.equal(approval.scope, REPAIR_SCOPE); return handle; },
    async poll(value) { events.push('poll'); assert.equal(value.sessionId, handle.sessionId);
      return pendingPolls-- > 0 ? { ...handle, status: 'pending' } : { ...handle, status: 'completed', evidence: proof, files }; },
    async cleanup(value) { events.push('cleanup'); assert.equal(value.sessionId, handle.sessionId);
      return pendingCleanup-- > 0 ? { status: 'pending' } : { status: 'deleted', apiRemovalAcknowledged: true }; },
  };
  const caller = { async call(value) { events.push('call'); assert.equal(value.mergeCommit, mergeSha); assert.equal(value.deployedCommit, mergeSha);
    assert.equal(value.testsPassed && value.ciPassed && value.deploymentVerified && value.replayVerified, true);
    return { status: 'submitted_not_verified' }; } };
  return { events, advances, logs, store, github, runner, caller,
    get job() { return job; },
    create() { return createFastWorker({ store, github, runner, caller, clock: () => time,
      sleep: async (ms) => { events.push(`sleep:${ms}`); time += ms; }, logger: (entry) => logs.push(entry) }); },
  };
}

test('approved repair runs ordered proof, cleanup, PR, CI, merge, exact live replay and callback', async () => {
  const f = fixture();
  assert.deepEqual(await f.create().run(receiptId), { status: 'completed' });
  assert.deepEqual(f.events, ['snapshot', 'repair', 'poll', 'cleanup', 'pr', 'ci', 'merge', 'confirm_merge', 'replay', 'call']);
  assert.deepEqual(f.advances.map((p) => p.phase), ['repair_poll', 'cleanup', 'create_pr', 'ci_wait', 'merge', 'deployment_wait', 'callback', 'completed']);
  assert.equal(f.job.state.callbackStatus, 'submitted_not_verified');
  assert.equal(f.job.state.files, null);
  assert.equal(f.job.state.handle, null);
  assert.equal(f.logs.length, 8);
  assert.deepEqual(await f.create().run(receiptId), { status: 'terminal' });
  assert.equal(f.events.filter((value) => value === 'call').length, 1);
  // Approval was consumed by intake. Its wall-clock expiry is not a later revoke.
  assert.ok(Date.parse(f.job.approval.expiresAt) < now);
});

test('pending external stages persist and resume without repeating successful writes', async () => {
  const f = fixture({ pendingPolls: 2, pendingCleanup: 1, pendingChecks: 1, pendingReplay: 1 });
  assert.deepEqual(await f.create().run(receiptId, { budgetMs: 3000 }), { status: 'resume_required' });
  assert.equal(f.job.phase, 'repair_poll');
  assert.deepEqual(await f.create().run(receiptId), { status: 'completed' });
  for (const event of ['repair', 'pr', 'merge', 'call']) assert.equal(f.events.filter((value) => value === event).length, 1);
  assert.equal(f.events.filter((value) => value === 'sleep:2000').length, 5);
});

test('incomplete coding proof never opens a PR or calls', async () => {
  for (const property of ['reproduced', 'fixed', 'regressionTestExecuted', 'artifactsVerified', 'readOnlyFilesUnchanged']) {
    const f = fixture({ phase: 'repair_poll', state: { handle } });
    f.runner.poll = async () => ({ ...handle, status: 'completed', evidence: { ...proof, [property]: false }, files });
    assert.deepEqual(await f.create().run(receiptId), { status: 'failed' });
    assert.equal(f.job.state.stoppedAtPhase, 'repair_poll');
    assert.equal(f.events.includes('pr'), false);
    assert.equal(f.events.includes('call'), false);
    assert.equal(f.job.state.cleanupVerified, true);
  }
});

test('a successful replay from another commit cannot produce the completion call', async () => {
  const f = fixture({ phase: 'deployment_wait', state: readyState });
  f.github.replay = async () => ({ status: 'passed', deployedCommit: 'e'.repeat(40) });
  assert.deepEqual(await f.create().run(receiptId), { status: 'failed' });
  assert.equal(f.job.state.stoppedAtPhase, 'deployment_wait');
  assert.equal(f.events.includes('call'), false);
});

test('unconfirmed merge provenance blocks replay and callback', async () => {
  const f = fixture({ phase: 'deployment_wait', state: readyState });
  f.github.confirmMerged = async () => ({ status: 'failed' });
  assert.deepEqual(await f.create().run(receiptId), { status: 'failed' });
  assert.equal(f.events.includes('replay'), false);
  assert.equal(f.events.includes('call'), false);
});

test('uncertain external writes quarantine with fixed safe state and are not retried', async () => {
  for (const [phase, component, method] of [
    ['repair_start', 'runner', 'startApprovedRepair'], ['create_pr', 'github', 'createPullRequest'],
    ['merge', 'github', 'merge'], ['callback', 'caller', 'call'],
  ]) {
    const f = fixture({ phase, state: readyState });
    let writes = 0;
    f[component][method] = async () => { writes += 1; throw Error('private provider detail'); };
    assert.deepEqual(await f.create().run(receiptId), { status: 'unknown' });
    assert.equal(f.job.state.stoppedAtPhase, phase);
    if (phase === 'callback') assert.equal(f.job.state.callbackStatus, 'unknown');
    assert.doesNotMatch(JSON.stringify(f.advances), /private provider detail/);
    assert.doesNotMatch(JSON.stringify(f.logs), /private provider detail/);
    await f.create().run(receiptId);
    assert.equal(writes, 1);
  }
});

test('lost persistence response after a PR never immediately repeats the external write', async () => {
  for (const committed of [false, true]) {
    const f = fixture({ phase: 'create_pr', state: readyState });
    const advance = f.store.advance;
    let first = true;
    f.store.advance = async (job, next) => {
      if (!first) return advance(job, next);
      first = false;
      if (committed) await advance(job, next);
      throw Error('storage response lost');
    };
    await assert.rejects(f.create().run(receiptId), /storage response lost/);
    assert.equal(f.events.filter((value) => value === 'pr').length, 1);
    const result = await f.create().run(receiptId);
    assert.equal(result.status, committed ? 'completed' : 'busy');
    assert.equal(f.events.filter((value) => value === 'pr').length, 1);
  }
});

test('mismatched approval is stopped before provider calls', async () => {
  const f = fixture();
  const claim = f.store.claim;
  f.store.claim = async (id) => {
    const result = await claim(id);
    return { ...result, approval: { ...result.approval, baseSha: 'e'.repeat(40) } };
  };
  assert.deepEqual(await f.create().run(receiptId), { status: 'failed' });
  assert.deepEqual(f.events, []);
});

test('a stale snapshot fails before starting the coding session or callback', async () => {
  const f = fixture();
  f.github.snapshot = async () => { throw Error('incident_base_changed'); };
  assert.deepEqual(await f.create().run(receiptId), { status: 'failed' });
  assert.equal(f.job.state.stoppedAtPhase, 'repair_start');
  assert.deepEqual(f.events, []);
});

test('real loopback signed intake drives injected repair providers and completion transport exactly once', async (t) => {
  const webhookSecret = 'synthetic_webhook_secret_not_real';
  const values = { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: '2'.repeat(32),
    TWILIO_FROM_NUMBER: '+12025550101', TEST_RESIDENT_NUMBER: '+12025550102' };
  let f, work, callbackSubmissions = 0, accepted = null;
  const app = createApp({ sentryOptions: {
    getConfig: () => ({ webhookSecret, projectId: '123' }),
    async onVerified(receipt, normalized) {
      assert.equal(normalized.details.baseSha, baseSha);
      assert.equal(normalized.eventId, receipt.receiptId);
      assert.doesNotMatch(JSON.stringify(normalized), /fictional_private_marker/);
      if (accepted === normalized.eventId) return { status: 'duplicate', receiptId: accepted };
      accepted = normalized.eventId;
      f = fixture({ id: accepted });
      f.job.event = normalized;
      f.caller.call = createCompletionCaller({ config: { liveVoiceEnabled: true, values }, fetcher: async (url, options) => {
        callbackSubmissions += 1;
        assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${values.TWILIO_ACCOUNT_SID}/Calls.json`);
        assert.equal(new URLSearchParams(options.body).get('To'), values.TEST_RESIDENT_NUMBER);
        assert.equal(f.job.phase, 'callback');
        assert.equal(f.job.state.deployedCommit, mergeSha);
        return Response.json({ sid: `CA${'3'.repeat(32)}`, account_sid: values.TWILIO_ACCOUNT_SID,
          from: values.TWILIO_FROM_NUMBER, to: values.TEST_RESIDENT_NUMBER, direction: 'outbound-api', status: 'queued' }, { status: 201 });
      } }).call;
      work = f.create().run(accepted);
      return { status: 'queued', receiptId: accepted };
    },
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${app.address().port}/api/webhooks/sentry`;
  const raw = JSON.stringify({ action: 'triggered', data: { event: { project: '123', issue_id: '42',
    release: baseSha, tags: [['errand_demo', 'upload_lf_v1']], request: { data: 'fictional_private_marker' } } } }, null, 2);
  const headers = { 'content-type': 'application/json', 'sentry-hook-resource': 'event_alert',
    'sentry-hook-signature': createHmac('sha256', webhookSecret).update(raw).digest('hex') };
  const response = await fetch(endpoint, { method: 'POST', body: raw, headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).processing, 'queued');
  assert.deepEqual(await work, { status: 'completed' });
  assert.equal(callbackSubmissions, 1);
  const duplicate = await fetch(endpoint, { method: 'POST', body: raw, headers });
  assert.equal((await duplicate.json()).processing, 'duplicate');
  assert.equal(callbackSubmissions, 1);
  assert.equal(f.job.state.callbackStatus, 'submitted_not_verified');
});
