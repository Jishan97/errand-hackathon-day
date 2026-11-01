// Credential-free SQL + runtime integration. Same isolated PGlite contract as
// test-fast-incident.mjs; pass @electric-sql/pglite@0.5.14/dist/index.js as argv[2].
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGmailRuntime } from '../src/core/gmail-runtime.js';
import { handleGmailDemo } from '../src/core/gmail-http.js';
if (!process.argv[2]) throw Error('Pass an explicit PGlite module path');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const sql = await readFile(new URL('./gmail.sql', import.meta.url), 'utf8');
const user = 'operator-demo', origin = 'https://errand.example.test', token = 'fictional_operator_token_'.repeat(2);
const values = { ENABLE_GMAIL_DEMO: 'true', PUBLIC_BASE_URL: origin, OPERATOR_TOKEN: token, COMPOSIO_API_KEY: 'fixture-key', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_test' };
const input = { action: 'send', to: 'recipient@example.test', subject: 'Repair', body: 'Friday after three.', attachmentAssetIds: null };
async function fixture(run) {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;'); await db.exec(sql);
    const rpc = async (op, owner, args = {}) => (await db.query('select public.errand_gmail($1,$2,$3) as result', [op, owner, args])).rows[0].result;
    const state = { sends: 0, drafts: 0, timeout: false, proposalId: null };
    let runtime;
    const account = { id: 'ca_test', user_id: user, toolkit: { slug: 'gmail' }, status: 'ACTIVE', is_disabled: false,
      auth_config: { id: 'ac_test', is_disabled: false, is_composio_managed: true } };
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/connected_accounts/link')) return Response.json({ connected_account_id: 'ca_test', redirect_url: 'https://connect.composio.dev/test' });
      if (url.endsWith('/complete_auth')) return Response.json({ connected_account_id: 'ca_test', toolkit_slug: 'gmail' });
      if (url.endsWith('/connected_accounts/ca_test')) return Response.json(account);
      const request = JSON.parse(options.body), endpoint = new URL(request.endpoint);
      assert.equal(request.user_id, user); assert.equal(request.connected_account_id, 'ca_test');
      let data;
      if (endpoint.pathname.endsWith('/profile')) data = { emailAddress: 'caller@example.test' };
      else if (endpoint.pathname.endsWith('/messages/send')) { state.sends++; if (state.timeout) throw Error('lost receipt'); data = { id: 'message-test' }; }
      else if (endpoint.pathname.endsWith('/drafts') && request.method === 'POST') { state.drafts++; data = { id: 'draft-test' }; }
      else if (endpoint.pathname.endsWith('/messages')) data = { messages: [{ id: 'message-test' }] };
      else {
        const p = await runtime.store.getProposal(state.proposalId);
        const message = { id: 'message-test', labelIds: ['SENT'], payload: { mimeType: 'text/plain',
          headers: Object.entries({ From: p.from, To: p.to, Subject: p.subject, 'Message-ID': p.messageId }).map(([name,value]) => ({ name,value })),
          body: { data: Buffer.from(p.body).toString('base64url') } } };
        data = endpoint.pathname.includes('/drafts/') ? { id: 'draft-test', message } : message;
      }
      return Response.json({ status: 200, data });
    };
    runtime = createGmailRuntime(values, { rpc, fetchImpl });
    const cookie = runtime.auth.login(`Bearer ${token}`).split(';')[0];
    const context = runtime.auth.authenticate({ headers: { cookie } });
    const connect = async () => { await runtime.connections.connect(context); await runtime.connections.complete(context, 'fictional-session-uri'); };
    const prepare = async (message = input, task) => {
      const ctx = task ?? await runtime.store.newTask();
      const p = await runtime.capability.prepare(ctx, message); state.proposalId = p.proposalId;
      return { ...p, ctx, scope: (await runtime.capability.approvalRequest(ctx, p.proposalId)).scope };
    };
    await run({ db, rpc, runtime, state, context, connect, prepare, cookie });
  } finally { await db.close(); }
}

test('SQL enforces role permissions and one-use browser-bound OAuth attempts', async () => fixture(async f => {
  await f.runtime.connections.connect(f.context);
  await assert.rejects(f.runtime.connections.complete({ ...f.context, sessionId: 'other-session' }, 'uri'), /connection_expired/);
  const attempts = await Promise.allSettled([f.runtime.connections.complete(f.context, 'uri'), f.runtime.connections.complete(f.context, 'uri')]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.runtime.store.getBinding(user)).email, 'caller@example.test');
  await f.db.exec('set role anon');
  await assert.rejects(f.rpc('get_binding', user), /permission denied/);
  await f.db.exec('reset role');
  await f.db.exec('set role service_role');
  assert.equal((await f.rpc('get_binding', user)).userId, user);
  await f.db.exec('reset role');
}));

test('real HTTP approval queues, one worker claims, Gmail readback verifies, and repeat resume does not resend', async () => fixture(async f => {
  await f.connect(); const pending = [];
  const options = { getValues: () => values, createRuntime: () => f.runtime, schedule: promise => pending.push(promise) };
  const req = (action, body) => new Request(`${origin}/api/gmail/${action}`, { method: 'POST',
    headers: { Cookie: f.cookie, Origin: origin, 'X-Errand-Intent': 'gmail-demo', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const prepared = await handleGmailDemo(req('prepare', { taskId: null, message: input }), options);
  assert.equal(prepared.status, 200); const p = await prepared.json(); f.state.proposalId = p.proposalId;
  const approve = req('approve', { proposalId: p.proposalId, digest: p.approval.digest, confirmed: true, attachmentConfirmed: false });
  assert.equal((await handleGmailDemo(approve, options)).status, 202); await Promise.all(pending);
  assert.equal((await f.runtime.store.getOutcome(p.proposalId)).status, 'verified'); assert.equal(f.state.sends, 1);
  assert.equal((await handleGmailDemo(req('resume', { proposalId: p.proposalId }), options)).status, 202); await Promise.all(pending);
  assert.equal(f.state.sends, 1);
}));

test('SQL exact approval, atomic claim and durable attempting state block replay and unresolved new work', async () => fixture(async f => {
  await f.connect(); const p = await f.prepare();
  assert.equal(await f.runtime.store.approve({ ...p.scope, digest: 'wrong' }), false);
  assert.equal(await f.runtime.store.approve(p.scope), true);
  const claims = await Promise.all([f.rpc('claim', user, { id: p.proposalId, scope: p.scope }), f.rpc('claim', user, { id: p.proposalId, scope: p.scope })]);
  assert.deepEqual(claims, [true, false]); assert.equal((await f.runtime.store.getOutcome(p.proposalId)).status, 'attempting');
  assert.equal(await f.rpc('get_proposal', 'another-user', { id: p.proposalId }), null);
  await assert.rejects(f.runtime.store.newTask(), /gmail_unresolved/);
  await assert.rejects(f.runtime.store.reviseTask(p.ctx.taskId), /gmail_unresolved/);
  assert.equal(await f.runtime.store.cancel(p.proposalId), false);
  assert.equal(await f.rpc('can_reconcile', user, { id: p.proposalId, scope: p.scope }), false);
}));

test('SQL correction invalidates prior approval and reconnect blocks an old binding', async () => fixture(async f => {
  await f.connect(); const p = await f.prepare();
  const next = await f.runtime.store.reviseTask(p.ctx.taskId);
  assert.equal(next.revision, 2); assert.equal(await f.runtime.store.approve(p.scope), false);
  const changed = await f.prepare({ ...input, body: 'Monday, please.' }, next);
  assert.equal(await f.runtime.store.approve(changed.scope), true);
  await f.connect();
  assert.equal(await f.rpc('claim', user, { id: changed.proposalId, scope: changed.scope }), false);
  assert.equal(await f.runtime.store.cancel(changed.proposalId), true);
  assert.ok(await f.runtime.store.newTask());
}));

test('lost send receipt reconciles saved content without resetting the consumed claim', async () => fixture(async f => {
  await f.connect(); const p = await f.prepare(); await f.runtime.store.approve(p.scope); f.state.timeout = true;
  assert.equal((await f.runtime.run(p.proposalId)).status, 'uncertain'); assert.equal(f.state.sends, 1);
  await assert.rejects(f.runtime.store.newTask(), /gmail_unresolved/);
  assert.equal((await f.runtime.run(p.proposalId)).status, 'verified'); assert.equal(f.state.sends, 1);
  await f.runtime.store.recordOutcome(p.proposalId, { status: 'uncertain' });
  assert.equal((await f.runtime.store.getOutcome(p.proposalId)).status, 'verified');
}));

test('expired approval rejects before provider write and abandoned claim waits for recovery lease', async () => fixture(async f => {
  await f.connect(); const p = await f.prepare(); await f.runtime.store.approve(p.scope);
  await f.db.query("update errand.gmail_proposals set approved_until=clock_timestamp()-interval '1 second' where id=$1", [p.proposalId]);
  await assert.rejects(f.runtime.run(p.proposalId), /approval_required/);
  assert.equal(f.state.sends, 0); assert.equal((await f.runtime.store.getOutcome(p.proposalId)).status, 'rejected');
  const other = await f.prepare(); await f.runtime.store.approve(other.scope);
  await f.rpc('claim', user, { id: other.proposalId, scope: other.scope });
  await assert.rejects(f.runtime.run(other.proposalId), /reconcile_not_authorized/);
  await f.db.query("update errand.gmail_proposals set claimed_at=clock_timestamp()-interval '6 minutes' where id=$1", [other.proposalId]);
  assert.equal((await f.runtime.run(other.proposalId)).status, 'verified'); assert.equal(f.state.sends, 0);
}));

test('draft worker creates only a draft and private asset storage enforces task ownership and immutability', async () => fixture(async f => {
  await f.connect(); const p = await f.prepare({ ...input, action: 'save_draft' }); await f.runtime.store.approve(p.scope);
  assert.equal((await f.runtime.run(p.proposalId)).status, 'verified'); assert.equal(f.state.drafts, 1); assert.equal(f.state.sends, 0);
  const task = await f.runtime.store.newTask();
  const asset = { assetId: 'asset-test', userId: user, taskId: task.taskId, filename: 'card.png', mimeType: 'image/png', description: 'Fictional image.', bytes: Buffer.from([1,2,3]) };
  await f.runtime.store.putImageAsset(asset);
  assert.deepEqual((await f.runtime.store.resolveImageAsset(task, 'asset-test')).bytes, Buffer.from([1,2,3]));
  assert.equal(await f.runtime.store.resolveImageAsset({ ...task, taskId: randomUUID() }, 'asset-test'), null);
  await assert.rejects(f.runtime.store.putImageAsset(asset), /duplicate key/);
}));

test('unresolved work is discoverable and manual closure is acknowledged, terminal and never restores the claim', async () => fixture(async f => {
  await f.connect(); const p = await f.prepare(); await f.runtime.store.approve(p.scope);
  await f.rpc('claim', user, { id: p.proposalId, scope: p.scope });
  assert.deepEqual(await f.runtime.store.pending(), [{ proposalId: p.proposalId, taskId: p.ctx.taskId, status: 'attempting' }]);
  await assert.rejects(f.runtime.store.newTask(), error => error.code === 'gmail_unresolved' && error.status === 409 && error.proposalId === p.proposalId);
  assert.equal(await f.runtime.store.closeManual(p.proposalId, p.scope.digest, 'reviewed_mailbox_may_have_been_sent'), false);
  await f.db.query("update errand.gmail_proposals set claimed_at=clock_timestamp()-interval '6 minutes' where id=$1", [p.proposalId]);
  assert.equal(await f.runtime.store.closeManual(p.proposalId, p.scope.digest, 'unchecked'), false);
  assert.equal(await f.runtime.store.closeManual(p.proposalId, 'wrong', 'reviewed_mailbox_may_have_been_sent'), false);
  assert.equal(await f.runtime.store.closeManual(p.proposalId, p.scope.digest, 'reviewed_mailbox_may_have_been_sent'), true);
  const outcome = await f.runtime.store.getOutcome(p.proposalId);
  assert.equal(outcome.status, 'manual_review_closed'); assert.equal(outcome.actor, user); assert.equal(outcome.mayHaveBeenDelivered, true);
  await f.runtime.store.recordOutcome(p.proposalId, { status: 'verified' });
  assert.equal((await f.runtime.run(p.proposalId)).status, 'manual_review_closed'); assert.equal(f.state.sends, 0);
  assert.equal(await f.rpc('claim', user, { id: p.proposalId, scope: p.scope }), false);
  assert.deepEqual(await f.runtime.store.pending(), []); assert.ok(await f.runtime.store.newTask());
}));
