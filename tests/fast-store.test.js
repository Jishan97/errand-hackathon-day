import test from 'node:test';
import assert from 'node:assert/strict';
import { FAST_SCOPE, createFastStore, createFastRpc } from '../src/storage/fast-store.js';

const receipt = 'a'.repeat(32), sha = 'b'.repeat(40);
const uuid = '11111111-1111-4111-8111-111111111111';
const date = '2026-11-01T12:00:00Z';
const event = { eventId: receipt, project: '123', title: 'Sample plant upload failed', details: { baseSha: sha, issueId: '456', fixture: 'upload_lf_v1' } };
const approved = { id: uuid, baseSha: sha, scope: FAST_SCOPE, expiresAt: date };

test('fast store binds approval, normalized event, claimed job and phase update', async () => {
  const calls = [];
  const results = [
    { status: 'approved', ...approved }, { status: 'queued', receiptId: receipt },
    { status: 'claimed', id: receipt, phase: 'repair_start', state: {}, event, approval: approved, lease: uuid, createdAt: date },
    { status: 'recorded', receiptId: receipt, phase: 'repair_poll' },
  ];
  const store = createFastStore({ rpc: async (name, args) => { calls.push({ name, args }); return results.shift(); } });
  assert.equal((await store.arm(sha)).baseSha, sha);
  assert.equal((await store.accept(event)).status, 'queued');
  const job = await store.claim(receipt);
  assert.equal(job.approval.scope, FAST_SCOPE);
  await store.advance(job, { phase: 'repair_poll', state: { handle: { sessionId: 'fictional-session' } } });
  assert.deepEqual(calls.map((call) => call.name), ['errand_fast_arm', 'errand_fast_accept', 'errand_fast_claim', 'errand_fast_advance']);
  assert.equal(calls.at(-1).args.p_lease, uuid);
});

test('invalid bindings, raw content, getters and credentials stop before storage', () => {
  let calls = 0;
  const store = createFastStore({ rpc: () => { calls++; } });
  assert.throws(() => store.arm(sha, 'any-repository'));
  assert.throws(() => store.accept({ ...event, raw: 'private content' }));
  assert.throws(() => store.accept({ ...event, details: { ...event.details, issueId: 'not-numeric' } }));
  assert.throws(() => store.claim('../another'));
  assert.throws(() => store.advance({ id: receipt, lease: uuid }, { phase: 'repair_poll', state: { auth_token: 'synthetic' } }));
  let getterRan = false;
  assert.throws(() => store.advance({ id: receipt, lease: uuid }, { phase: 'repair_poll', state: { get field() { getterRan = true; return 'bad'; } } }));
  assert.equal(getterRan, false);
  assert.equal(calls, 0);
});

test('mismatched store responses fail closed without raw provider errors', async () => {
  const mismatch = createFastStore({ rpc: async () => ({ status: 'approved', ...approved, baseSha: 'c'.repeat(40) }) });
  await assert.rejects(mismatch.arm(sha), /^Error: fast_storage_response_invalid$/);
  const error = createFastStore({ rpc: async () => { throw new Error('sensitive fictional provider detail'); } });
  await assert.rejects(error.accept(event), /^Error: fast_storage_request_unconfirmed$/);
  const wrongEvent = createFastStore({ rpc: async () => ({ status: 'claimed', id: receipt, phase: 'repair_start', state: {},
    event, approval: { ...approved, baseSha: 'd'.repeat(40) }, lease: uuid, createdAt: date }) });
  await assert.rejects(wrongEvent.claim(receipt), /^Error: fast_storage_response_invalid$/);
});

test('status projects only safe evidence and does not expose internal state', async () => {
  const ids = [];
  const store = createFastStore({ rpc: async (name, args) => { ids.push(args.p_id); return ({ status: 'found', receiptId: receipt, phase: 'ci_wait', createdAt: date,
    updatedAt: date, elapsedMs: 2000, testsPassed: true, ciPassed: false, replayVerified: false,
    pullRequest: 'https://github.com/Jishan97/errand-agent-demo/pull/8', cleanupVerified: true, stoppedAtPhase: 'ci_wait',
    state: { sessionId: 'not-public' } }); } });
  const value = await store.status(receipt);
  assert.equal(value.testsPassed, true);
  assert.equal(value.pullRequest.endsWith('/8'), true);
  assert.equal('state' in value, false);
  assert.equal(JSON.stringify(value).includes('not-public'), false);
  assert.equal(value.cleanupVerified, true);
  assert.equal(value.stoppedAtPhase, 'ci_wait');
  assert.equal((await store.status()).receiptId, receipt);
  assert.deepEqual(ids, [receipt, null]);
});

test('RPC transport uses server apikey only and a fixed allowlisted HTTPS path', async () => {
  const secret = 'sb_secret_' + 'x'.repeat(32);
  let call;
  const rpc = createFastRpc({ url: 'https://abcdefghijklmnopqrst.supabase.co', secret,
    fetcher: async (url, options) => { call = { url, options }; return Response.json({ status: 'missing' }); } });
  assert.deepEqual(await rpc('errand_fast_status', { p_id: receipt }), { status: 'missing' });
  assert.equal(call.url, 'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/errand_fast_status');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.apikey, secret);
  assert.equal('Authorization' in call.options.headers, false);
  await assert.rejects(rpc('../untrusted', {}));
  assert.throws(() => createFastRpc({ url: 'https://example.com', secret }));
  assert.throws(() => createFastRpc({ url: 'https://abcdefghijklmnopqrst.supabase.co/a', secret }));
});

test('RPC rejects failures, oversized bodies and timed out requests with fixed errors', async () => {
  const options = { url: 'https://abcdefghijklmnopqrst.supabase.co', secret: 'sb_secret_' + 'x'.repeat(32) };
  for (const fetcher of [
    async () => new Response('private provider diagnostic', { status: 401 }),
    async () => new Response('x'.repeat(192001)),
    async () => { throw new Error('private connection failure'); },
  ]) {
    const rpc = createFastRpc({ ...options, fetcher });
    await assert.rejects(rpc('errand_fast_status', { p_id: receipt }), /^Error: fast_storage_request_unconfirmed$/);
  }
  const hanging = createFastRpc({ ...options, timeoutMs: 5, fetcher: () => new Promise(() => {}) });
  await assert.rejects(hanging('errand_fast_status', { p_id: receipt }), /^Error: fast_storage_request_unconfirmed$/);
});
