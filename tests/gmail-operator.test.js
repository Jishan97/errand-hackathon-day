import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGmailAuth } from '../src/core/gmail-auth.js';
import { handleGmailDemo } from '../src/core/gmail-http.js';
import { createGmailRuntime, gmailPublicOrigin, gmailRuntimeValues } from '../src/core/gmail-runtime.js';
import { createGmailRpc, createGmailStore } from '../src/storage/gmail-store.js';
import { createApp } from '../src/app.js';
import deployed from '../api/gmail/[action].js';
import connectionIndex from '../api/connections/gmail/index.js';
import connectionAction from '../api/connections/gmail/[action].js';
import { GmailError } from '../src/integrations/gmail/composio.js';

const origin = 'https://errand.example.test', token = 'fictional_operator_token_'.repeat(2);
const values = { ENABLE_GMAIL_DEMO: 'true', PUBLIC_BASE_URL: origin + '/', OPERATOR_TOKEN: token,
  COMPOSIO_API_KEY: 'fictional-key', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_test' };
const proposalId = '11111111-1111-4111-8111-111111111111', taskId = '22222222-2222-4222-8222-222222222222';
const cookie = () => createGmailAuth({ token }).login(`Bearer ${token}`).split(';')[0];
function request(action, body, headers = {}) {
  return new Request(`${origin}/api/gmail/${action}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie(), ...(body === undefined ? {} : { Origin: origin, 'X-Errand-Intent': 'gmail-demo', 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function fixture() {
  const scope = { userId: 'operator-demo', proposalId, taskId, revision: 1, digest: 'a'.repeat(64) };
  const calls = [], pending = [];
  const approval = { scope, attachmentRequiresExplicitConfirmation: false, readback: { to: 'recipient@example.test', attachments: [] } };
  const runtime = {
    contextFor: async () => ({ userId: 'operator-demo', taskId, revision: 1 }),
    capability: { approvalRequest: async () => approval, search: async () => ({ messages: [] }),
      prepare: async (context, input) => { calls.push(['prepare', context, input]); return { proposalId }; } },
    store: { approve: async value => { calls.push(['approve', value]); return true; }, getOutcome: async () => ({ status: 'queued' }),
      newTask: async () => ({ userId: 'operator-demo', taskId, revision: 1 }),
      reviseTask: async id => { calls.push(['revise', id]); return { userId: 'operator-demo', taskId, revision: 2 }; },
      cancel: async () => false },
    run: async id => { calls.push(['run', id]); },
  };
  const options = { getValues: () => values, createRuntime: () => runtime, schedule: promise => pending.push(promise) };
  return { scope, approval, calls, pending, runtime, options };
}

test('operator cookie is signed, short-lived, private and tied to a distinct browser session', () => {
  let now = 1000; const auth = createGmailAuth({ token, now: () => now });
  assert.throws(() => auth.login('Bearer incorrect'), /operator_rejected/);
  const a = auth.login(`Bearer ${token}`), b = auth.login(`Bearer ${token}`);
  assert.match(a, /HttpOnly; Secure; SameSite=Lax; Max-Age=1800/); assert.ok(!a.includes(token));
  const admit = value => auth.authenticate({ headers: { cookie: value.split(';')[0] } });
  assert.equal(admit(a).userId, 'operator-demo'); assert.notEqual(admit(a).sessionId, admit(b).sessionId);
  assert.equal(admit(a.replace(/=./, '=x')), null);
  assert.equal(auth.authenticate({ headers: { cookie: `${a.split(';')[0]}; ${a.split(';')[0]}` } }), null);
  assert.equal(createGmailAuth({ token: 'different_valid_token_'.repeat(2), now: () => now }).authenticate({ headers: { cookie: a.split(';')[0] } }), null);
  now += 1800000; assert.equal(admit(a), null);
});
test('Gmail flag/config is independent of Sentry and normalizes only a bare HTTPS origin', () => {
  assert.equal(gmailPublicOrigin(values), origin);
  for (const url of ['http://example.test', origin + '/path', origin + '?query=1', 'https://user@example.test']) {
    assert.throws(() => gmailPublicOrigin({ ...values, PUBLIC_BASE_URL: url }), /setup_required/);
  }
  assert.throws(() => gmailPublicOrigin({ ...values, ENABLE_GMAIL_DEMO: 'false' }), /setup_required/);
  assert.equal(gmailRuntimeValues({ ...values, OPENAI_API_KEY: 'fictional-key' }).OPENAI_API_KEY, 'fictional-key');
  const runtime = createGmailRuntime(values, { rpc: async () => null });
  assert.equal(runtime.tools.length, 4); assert.equal(runtime.tools.at(-1).name, 'generate_task_image'); assert.equal(typeof runtime.bindTools, 'function');
  assert.equal(runtime.tools.some(tool => Object.hasOwn(tool, 'strict')), false);
});
test('deployed method probes do not instantiate providers or require deployment secrets', async () => {
  assert.equal(connectionIndex, deployed); assert.equal(connectionAction, deployed);
  assert.equal((await deployed.fetch(request('login'))).status, 405);
  assert.equal((await handleGmailDemo(request('session'))).status, 503);
});
test('operator login rejects cross-origin and unsigned access before constructing the Gmail runtime', async () => {
  let runtimes = 0;
  const options = { getValues: () => values, createRuntime: () => { runtimes++; throw Error('must not run'); } };
  assert.equal((await handleGmailDemo(request('login', {}, { Origin: 'https://evil.example.test', Authorization: `Bearer ${token}` }), options)).status, 403);
  assert.equal((await handleGmailDemo(request('login', {}, { Authorization: 'Bearer bad' }), options)).status, 403);
  const login = await handleGmailDemo(request('login', {}, { Authorization: `Bearer ${token}` }), options);
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /__Host-errand-gmail=/);
  assert.equal((await handleGmailDemo(request('search', { query: 'test' }, { Cookie: '' }), options)).status, 401);
  assert.equal(runtimes, 0);
});
test('callback with an expired session redirects without exposing its one-use token', async () => {
  const result = await handleGmailDemo(new Request(origin + '/api/connections/gmail/callback?session_uri=fictional-private-token'), { getValues: () => values });
  assert.equal(result.status, 303); assert.equal(result.headers.get('location'), '/connections.html?connection=failed');
  assert.ok(!(await result.text()).includes('fictional-private-token'));
});
test('approval checks exact digest and explicit image consent before durable queue and scheduling', async () => {
  const f = fixture(); f.approval.attachmentRequiresExplicitConfirmation = true;
  const body = { proposalId, digest: f.scope.digest, confirmed: true, attachmentConfirmed: false };
  assert.equal((await handleGmailDemo(request('approve', body), f.options)).status, 409);
  assert.equal((await handleGmailDemo(request('approve', { ...body, attachmentConfirmed: true, digest: 'wrong' }), f.options)).status, 409);
  assert.equal(f.calls.length, 0);
  const result = await handleGmailDemo(request('approve', { ...body, attachmentConfirmed: true }), f.options);
  assert.equal(result.status, 202); await Promise.all(f.pending);
  assert.deepEqual(f.calls, [['approve', f.scope], ['run', proposalId]]);
});
test('missing scheduler and rejected atomic approval do not launch a worker', async () => {
  const f = fixture(), body = { proposalId, digest: f.scope.digest, confirmed: true, attachmentConfirmed: false };
  assert.equal((await handleGmailDemo(request('approve', body), { ...f.options, schedule: undefined })).status, 503);
  assert.equal(f.calls.length, 0);
  f.runtime.store.approve = async () => false;
  assert.equal((await handleGmailDemo(request('approve', body), f.options)).status, 409); assert.equal(f.calls.length, 0);
});
test('prepare advances the existing task revision and rejects browser-supplied identity', async () => {
  const f = fixture();
  assert.equal((await handleGmailDemo(request('prepare', { taskId, message: {}, userId: 'other' }), f.options)).status, 400);
  assert.equal((await handleGmailDemo(request('prepare', { taskId, message: { action: 'send', to: 'not-a-mailbox', subject: 'Hi', body: 'Hello' } }), f.options)).status, 400);
  assert.equal(f.calls.length, 0);
  const result = await handleGmailDemo(request('prepare', { taskId, message: { action: 'save_draft', to: 'recipient@example.test', subject: 'Hello', body: 'A message.' } }), f.options);
  assert.equal(result.status, 200); assert.deepEqual(f.calls[0], ['revise', taskId]); assert.equal(f.calls[1][1].revision, 2);
  const prepared = await result.json(); assert.equal(prepared.approval.digest, f.scope.digest); assert.equal('scope' in prepared.approval, false);
});
test('HTTP rejects streamed oversize JSON and cancelled-after-claim operations', async () => {
  const f = fixture();
  assert.equal((await handleGmailDemo(request('search', { query: 'a'.repeat(9000) }), f.options)).status, 413);
  assert.equal((await handleGmailDemo(request('cancel', { proposalId }), f.options)).status, 409);
  assert.equal(f.calls.length, 0);
});
test('Gmail store binds all RPCs to its owner and keeps asset bytes server-side', async () => {
  const calls = [];
  const { store, approvalGate } = createGmailStore({ userId: 'operator-demo', rpc: async (...args) => { calls.push(args); return true; } });
  await assert.rejects(store.getBinding('other'), /gmail_owner_mismatch/);
  await assert.rejects(approvalGate.claim({ userId: 'other' }), /gmail_owner_mismatch/);
  await store.recordOutcome(proposalId, { status: 'uncertain' });
  assert.deepEqual(calls, [['record_outcome', 'operator-demo', { id: proposalId, value: { status: 'uncertain' } }]]);
});
test('Gmail RPC pins endpoint, limits operations and sanitizes database errors without retries', async () => {
  const calls = [];
  const rpc = createGmailRpc({ url: 'https://' + 'a'.repeat(20) + '.supabase.co', secret: 'sb_secret_' + 'b'.repeat(30),
    fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ private: 'never propagate' }, { status: 500 }); } });
  await assert.rejects(rpc('get_binding', 'operator-demo'), e => e.message === 'gmail_storage_unavailable');
  assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url).pathname, '/rest/v1/rpc/errand_gmail');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(rpc('errand_fast_claim', 'operator-demo'), /gmail_operation_invalid/); assert.equal(calls.length, 1);
});
test('Gmail RPC accepts SQL null as either an empty body or JSON null', async () => {
  for (const body of ['', 'null']) {
    const rpc = createGmailRpc({ url: 'https://' + 'a'.repeat(20) + '.supabase.co', secret: 'sb_secret_' + 'b'.repeat(30),
      fetcher: async () => new Response(body, { status: 200 }) });
    assert.equal(await rpc('get_binding', 'operator-demo'), null);
  }
});
test('pending route exposes unresolved IDs and manual closure requires the store acknowledgement check', async () => {
  const f = fixture();
  f.runtime.store.pending = async () => [{ proposalId, taskId, status: 'uncertain' }];
  let accepted = false;
  f.runtime.store.closeManual = async (id, digest, ack) => { assert.equal(id, proposalId); assert.equal(digest, f.scope.digest); return accepted && ack === 'reviewed_mailbox_may_have_been_sent'; };
  const pending = await handleGmailDemo(request('pending'), f.options);
  assert.deepEqual(await pending.json(), { proposals: [{ proposalId, taskId, status: 'uncertain' }] });
  const body = { proposalId, digest: f.scope.digest, acknowledgement: 'reviewed_mailbox_may_have_been_sent' };
  assert.equal((await handleGmailDemo(request('close-manual', body), f.options)).status, 409);
  accepted = true;
  assert.equal((await handleGmailDemo(request('close-manual', body), f.options)).status, 200);
  assert.equal(f.calls.length, 0); assert.equal(f.pending.length, 0);
});
test('unresolved work maps to HTTP 409 with its proposal ID and an unapproved resume is refused', async () => {
  const f = fixture();
  f.runtime.store.newTask = async () => { const error = new GmailError('gmail_unresolved', 409); error.proposalId = proposalId; throw error; };
  const result = await handleGmailDemo(request('prepare', { taskId: null,
    message: { action: 'send', to: 'recipient@example.test', subject: 'Hi', body: 'Hello' } }), f.options);
  assert.equal(result.status, 409); assert.deepEqual(await result.json(), { error: 'gmail_unresolved', proposalId });
  f.runtime.store.getOutcome = async () => null;
  assert.equal((await handleGmailDemo(request('resume', { proposalId }), f.options)).status, 403); assert.equal(f.pending.length, 0);
});
test('one local HTTP server serves Gmail and incident routes without cross-wiring authentication', async t => {
  const f = fixture(); const app = createApp({ gmailOptions: f.options }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const path of ['/gmail.html', '/connections.html', '/incident.html']) assert.equal((await fetch(base + path)).status, 200);
  assert.equal((await fetch(base + '/api/gmail/session', { headers: { Cookie: cookie() } })).status, 200);
  assert.equal((await fetch(base + '/api/incident/status', { headers: { Cookie: cookie() } })).status, 401);
  assert.equal((await fetch(base + '/api/webhooks/sentry', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 401);
});
