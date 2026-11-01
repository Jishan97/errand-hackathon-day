import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createComposioGmail, GmailError } from '../src/integrations/gmail/composio.js';
import { createGmailIntegration } from '../src/integrations/gmail/index.js';
import { createGmailConnections } from '../src/integrations/gmail/connections.js';
import { createGmailCapability, bindGmailTools, gmailTools } from '../src/integrations/gmail/capability.js';
import { createApp } from '../src/app.js';
import { verifyImages } from '../src/integrations/gmail/images.js';
import { MAX_IMAGE_BYTES, MAX_RAW_BYTES } from '../src/integrations/gmail/images.js';

// Entirely fictional fixtures. Memory state exists ONLY in tests, never in the app.
const ctx = { userId: 'test-user', sessionId: 'test-session', taskId: 'test-task', revision: 1 };
const active = () => ({ id: 'ca_test', user_id: ctx.userId, toolkit: { slug: 'gmail' },
  status: 'ACTIVE', is_disabled: false, auth_config: { id: 'ac_test', is_disabled: false, is_composio_managed: true } });
const binding = () => ({ userId: ctx.userId, accountId: 'ca_test', bindingId: 'binding-test', email: 'caller@example.test' });
const input = { action: 'send', to: 'recipient@example.test', subject: 'Repair appointment', body: 'Friday after three, please.' };
function fixture(options = {}) {
  const state = { binding: binding(), attempts: new Map(), proposals: new Map(), outcomes: new Map(),
    approved: new Map(), claimed: new Set(), currentProposal: null, sendCount: 0, draftCount: 0, reads: 0 };
  const store = {
    getBinding: async userId => state.binding?.userId === userId ? structuredClone(state.binding) : null,
    putAttempt: async a => state.attempts.set(`${a.userId}:${a.sessionId}`, structuredClone(a)),
    getAttempt: async (userId, sessionId) => state.attempts.get(`${userId}:${sessionId}`),
    finishAttempt: async (a, b) => {
      const key = `${a.userId}:${a.sessionId}`;
      if (state.attempts.get(key)?.id !== a.id) return false;
      state.attempts.delete(key); state.binding = structuredClone(b); return true;
    },
    putProposal: async p => {
      if ([...state.proposals.values()].some(old => old.taskId === p.taskId && (old.revision === p.revision
        || ['attempting', 'uncertain', 'verification_pending'].includes(state.outcomes.get(old.id)?.status)))) return false;
      state.proposals.set(p.id, structuredClone(p)); state.currentProposal = p.id; return true;
    },
    getProposal: async id => state.proposals.get(id),
    recordOutcome: async (id, outcome) => state.outcomes.set(id, structuredClone(outcome)),
    getOutcome: async id => state.outcomes.get(id),
  };
  function readback() {
    const p = state.proposals.get(state.currentProposal);
    const message = { id: 'message-test', labelIds: ['SENT'], payload: { mimeType: 'text/plain',
      headers: Object.entries({ From: p.from, To: p.to, Subject: p.subject, 'Message-ID': p.messageId }).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(p.body).toString('base64url') } } };
    if (p.images?.length) {
      message.payload.mimeType = 'multipart/mixed';
      message.payload.parts = [{ mimeType: 'text/plain', body: message.payload.body }, ...p.images.map(image => ({
        mimeType: image.mimeType, filename: image.filename,
        body: { size: image.size, data: Buffer.from(image.data, 'base64').toString('base64url') },
      }))];
      delete message.payload.body;
    }
    return message;
  }
  const provider = {
    link: async () => ({ accountId: 'ca_test', redirectUrl: 'https://connect.composio.dev/test' }),
    completeIdentity: async () => 'ca_test',
    verifyAccount: async (userId, accountId) => ({ userId, accountId }),
    profile: async () => ({ emailAddress: 'caller@example.test' }),
    list: async () => ({ messages: [{ id: 'message-test' }] }),
    read: async () => { state.reads++; return readback(); },
    readDraft: async () => ({ id: 'draft-test', message: readback() }),
    send: async () => { state.sendCount++; return { id: 'message-test' }; },
    saveDraft: async () => { state.draftCount++; return { id: 'draft-test' }; },
  };
  const connections = createGmailConnections({ provider, store, publicOrigin: 'https://errand.example.test', now: () => 1000 });
  const approvalGate = { claim: async scope => {
    if (state.claimed.has(scope.proposalId) || state.currentProposal !== scope.proposalId) return false;
    const p = state.proposals.get(scope.proposalId);
    if (state.approved.get(scope.proposalId) !== p.digest || scope.digest !== p.digest) return false;
    state.claimed.add(scope.proposalId); state.outcomes.set(scope.proposalId, { status: 'attempting' }); return true;
  }, canReconcile: async (context, scope) => context.userId === scope.userId && state.claimed.has(scope.proposalId) };
  const capability = createGmailCapability({ provider, store, connections, approvalGate,
    authorizeRead: async c => c.userId === ctx.userId, ...options });
  const approve = id => state.approved.set(id, state.proposals.get(id).digest);
  return { state, store, provider, connections, capability, approve, readback };
}
function restFixture(responseBody) {
  const calls = [];
  const provider = createComposioGmail({ apiKey: 'fictional-test-key', authConfigId: 'ac_test', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify(responseBody), { status: 200 });
  } });
  return { provider, calls };
}
test('REST verifies account and discards private provider fields', async () => {
  const { provider } = restFixture({ ...active(), state: { fictionalSecret: 'must-not-escape' } });
  assert.deepEqual(await provider.verifyAccount(ctx.userId, 'ca_test'), { userId: ctx.userId, accountId: 'ca_test' });
});
for (const [name, change] of [
  ['account', a => a.id = 'ca_other'], ['user', a => a.user_id = 'other'],
  ['toolkit', a => a.toolkit.slug = 'outlook'], ['auth config', a => a.auth_config.id = 'ac_other'],
  ['status', a => a.status = 'EXPIRED'], ['account disabled', a => a.is_disabled = true],
  ['config disabled', a => a.auth_config.is_disabled = true], ['custom OAuth', a => a.auth_config.is_composio_managed = false],
  ['missing ownership', a => delete a.user_id], ['shared account', a => a.experimental = { account_type: 'SHARED' }],
]) test(`REST rejects ${name} mismatch`, async () => {
  const account = active(); change(account);
  await assert.rejects(restFixture(account).provider.verifyAccount(ctx.userId, 'ca_test'), /connection_unavailable/);
});
test('REST link body is server-bound and redirect is allowlisted', async () => {
  const { provider, calls } = restFixture({ connected_account_id: 'ca_test', redirect_url: 'https://connect.composio.dev/test' });
  await provider.link(ctx.userId, 'https://errand.example.test/callback');
  assert.deepEqual(JSON.parse(calls[0].options.body), { user_id: ctx.userId, auth_config_id: 'ac_test', callback_url: 'https://errand.example.test/callback' });
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(restFixture({ connected_account_id: 'ca_test', redirect_url: 'https://evil.example.test' }).provider.link(ctx.userId, 'https://errand.example.test'), /invalid_provider_response/);
});
test('REST proxy pins Gmail URL, owner and account; rejects inner HTTP failure', async () => {
  const { provider, calls } = restFixture({ status: 200, data: { messages: [] } });
  await provider.list(binding(), 'from:person@example.test');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.connected_account_id, 'ca_test'); assert.equal(body.user_id, ctx.userId);
  assert.ok(body.endpoint.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?'));
  assert.equal(new URL(body.endpoint).searchParams.get('maxResults'), '5');
  await assert.rejects(restFixture({ status: 401, data: {} }).provider.profile(binding()), /provider_unavailable/);
});
test('provider transport errors are sanitized without retries', async () => {
  let count = 0;
  const provider = createComposioGmail({ apiKey: 'fictional', authConfigId: 'ac_test', fetchImpl: async () => { count++; throw new Error('sensitive provider text'); } });
  await assert.rejects(provider.send(binding(), { raw: 'test' }), e => e.message === 'provider_unavailable');
  assert.equal(count, 1);
});
test('OAuth callback verifies identity and atomically consumes an attempt', async () => {
  const f = fixture(); f.state.binding = null;
  await f.connections.connect(ctx);
  assert.equal((await f.connections.status(ctx)).status, 'not_connected');
  assert.equal((await f.connections.complete(ctx, 'fictional-session-uri')).status, 'connected');
  assert.ok(f.state.binding.bindingId);
  await assert.rejects(f.connections.complete(ctx, 'fictional-session-uri'), /connection_expired/);
});
test('callback without session_uri or without same browser session cannot bind', async () => {
  const f = fixture(); await f.connections.connect(ctx);
  await assert.rejects(f.connections.complete(ctx, null), /invalid_callback/);
  await assert.rejects(f.connections.complete({ ...ctx, sessionId: 'other' }, 'test'), /connection_expired/);
});
test('callback account mismatch and expiry do not bind', async () => {
  const f = fixture(); f.state.binding = null; await f.connections.connect(ctx);
  f.provider.completeIdentity = async () => 'ca_other';
  await assert.rejects(f.connections.complete(ctx, 'test'), /connection_mismatch/);
  assert.equal(f.state.binding, null);
  [...f.state.attempts.values()][0].expiresAt = 500;
  await assert.rejects(f.connections.complete(ctx, 'test'), /connection_expired/);
});
test('read tools require admitted caller and return bounded untrusted text', async () => {
  const f = fixture(); await f.capability.prepare(ctx, input);
  const result = await f.capability.read(ctx, 'message-test');
  assert.equal(result.untrusted, true); assert.equal(result.text, input.body);
  await assert.rejects(f.capability.read({ ...ctx, userId: 'other' }, 'message-test'), /read_not_authorized/);
  await assert.rejects(f.capability.search({}, 'hello'), /sign_in_required/);
});
test('prepare does not write to Gmail; approval is required for both effects', async () => {
  for (const action of ['send', 'save_draft']) {
    const f = fixture(); const p = await f.capability.prepare(ctx, { ...input, action });
    assert.equal(p.status, 'awaiting_approval'); assert.equal(f.state.sendCount + f.state.draftCount, 0);
    await assert.rejects(f.capability.executeApproved(ctx, p.proposalId), /approval_required/);
    assert.equal(f.state.sendCount + f.state.draftCount, 0);
  }
});
test('approved send verifies readback and concurrent workers cause exactly one adapter request', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  const results = await Promise.allSettled([f.capability.executeApproved(ctx, p.proposalId), f.capability.executeApproved(ctx, p.proposalId)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'fulfilled').value.status, 'verified');
  assert.equal(f.state.sendCount, 1);
});
test('approved save_draft verifies a Gmail draft without sending', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, { ...input, action: 'save_draft' }); f.approve(p.proposalId);
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verified');
  assert.equal(f.state.draftCount, 1); assert.equal(f.state.sendCount, 0);
});
test('changed revision, user, payload and mailbox reject old approval', async () => {
  for (const variant of ['revision', 'user', 'payload', 'mailbox']) {
    const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
    let context = ctx;
    if (variant === 'revision') context = { ...ctx, revision: 2 };
    if (variant === 'user') context = { ...ctx, userId: 'other' };
    if (variant === 'payload') f.state.proposals.get(p.proposalId).body = 'altered';
    if (variant === 'mailbox') f.state.binding.bindingId = 'new-binding';
    await assert.rejects(f.capability.executeApproved(context, p.proposalId),
      new RegExp(variant === 'payload' ? 'proposal_changed' : variant === 'mailbox' ? 'connection_changed' : 'stale_proposal'));
    assert.equal(f.state.sendCount, 0);
  }
});
test('a corrected proposal invalidates the prior approved proposal', async () => {
  const f = fixture(); const old = await f.capability.prepare(ctx, input); f.approve(old.proposalId);
  await f.capability.prepare({ ...ctx, revision: 2 }, { ...input, body: 'Monday instead.' });
  await assert.rejects(f.capability.executeApproved(ctx, old.proposalId), /approval_required/);
  assert.equal(f.state.sendCount, 0);
});
test('uncertain send remains consumed and can reconcile by its unique message ID', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.provider.send = async () => { f.state.sendCount++; throw new Error('timeout after acceptance'); };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'uncertain');
  await assert.rejects(f.capability.executeApproved(ctx, p.proposalId), /already_claimed/);
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'verified');
  assert.equal(f.state.sendCount, 1);
});
test('no Sent match is not proof of failure and does not retry', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.provider.send = async () => { f.state.sendCount++; return {}; };
  await f.capability.executeApproved(ctx, p.proposalId);
  f.provider.list = async () => ({ messages: [] });
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'uncertain');
  assert.equal(f.state.sendCount, 1);
});
test('wrong recipient/body or missing SENT label is never verified', async () => {
  for (const variant of ['to', 'body', 'label']) {
    const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
    f.provider.read = async () => { const m = f.readback();
      if (variant === 'to') m.payload.headers.find(h => h.name === 'To').value = 'wrong@example.test';
      if (variant === 'body') m.payload.body.data = Buffer.from('wrong').toString('base64url');
      if (variant === 'label') m.labelIds = [];
      return m;
    };
    assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verification_pending');
  }
});
test('receipt survives verification error and subsequent reconciliation does not resend', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.provider.read = async () => { throw new Error('offline'); };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).providerId, 'message-test');
  f.provider.read = async () => f.readback();
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'verified');
  assert.equal(f.state.sendCount, 1);
});
test('MIME is immutable UTF-8 with bounded headers and roundtrips a long Unicode subject', async () => {
  const f = fixture(); const subject = 'Réparation vendredi après-midi — '.repeat(3);
  const p = await f.capability.prepare(ctx, { ...input, subject }); f.approve(p.proposalId);
  const stored = f.state.proposals.get(p.proposalId);
  const raw = Buffer.from(stored.raw, 'base64url').toString('utf8');
  assert.ok(raw.includes('Content-Transfer-Encoding: base64'));
  assert.ok(raw.split('\r\n').every(line => Buffer.byteLength(line) < 998));
  f.provider.read = async () => { const m = f.readback();
    m.payload.headers.find(h => h.name === 'Subject').value = raw.match(/Subject: ([\s\S]*?)\r\nMessage-ID/)[1]; return m; };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verified');
});
test('header injection, extra recipients and model-supplied account are rejected', async () => {
  const f = fixture();
  for (const changed of [{ subject: 'Hi\r\nBcc: hidden@example.test' }, { to: 'a@example.test,b@example.test' }, { accountId: 'ca_other' }]) {
    await assert.rejects(f.capability.prepare(ctx, { ...input, ...changed }), /invalid_request/);
  }
  const dispatch = bindGmailTools(f.capability, async () => ctx);
  await assert.rejects(dispatch('gmail_send', input), /tool_not_available/);
  await assert.rejects(dispatch('gmail_search', { query: 'hello', userId: 'other' }), /invalid_request/);
});
async function withServer(options, run) {
  const server = createApp(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('default app serves UI, blocks disabled connectors and reports setup required', async () => {
  await withServer({}, async base => {
    const page = await fetch(`${base}/connections.html`); assert.equal(page.status, 200);
    const html = await page.text(); for (const name of ['Gmail', 'WhatsApp', 'Telegram']) assert.ok(html.includes(name));
    assert.equal((html.match(/<button disabled>Not in this demo/g) ?? []).length, 6);
    assert.equal((await fetch(`${base}/api/connections/gmail`)).status, 503);
    assert.equal((await fetch(`${base}/api/connections/telegram/connect`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});
test('HTTP blocks missing login, cross-origin POST, forged callback and wrong methods', async () => {
  const f = fixture(); let loggedIn = false;
  await withServer({ connections: f.connections, authenticate: async () => loggedIn ? ctx : null, publicOrigin: 'https://errand.example.test' }, async base => {
    assert.equal((await fetch(`${base}/api/connections/gmail`)).status, 401); loggedIn = true;
    for (const origin of [undefined, 'https://evil.example.test']) {
      assert.equal((await fetch(`${base}/api/connections/gmail/connect`, { method: 'POST', headers: { ...(origin ? { Origin: origin } : {}), 'X-Errand-Intent': 'connect-gmail' } })).status, 403);
    }
    assert.equal((await fetch(`${base}/api/connections/gmail/connect`)).status, 405);
    assert.equal((await fetch(`${base}/api/connections/gmail/connect`, { method: 'POST', headers: { Origin: 'https://errand.example.test', 'X-Errand-Intent': 'connect-gmail' } })).status, 200);
    const forged = await fetch(`${base}/api/connections/gmail/callback?status=ACTIVE&connected_account_id=ca_evil`, { redirect: 'manual' });
    assert.equal(forged.status, 303); assert.equal(forged.headers.get('location'), '/connections.html?connection=failed');
    assert.equal(f.state.binding.accountId, 'ca_test');
  });
});
test('composition refuses missing durable core dependencies', () => {
  assert.throws(() => createGmailIntegration({}), /store_contract_required/);
});
test('stale proposal persistence returns no approval-ready result', async () => {
  const f = fixture(); f.store.putProposal = async () => false;
  await assert.rejects(f.capability.prepare(ctx, input), /stale_or_unresolved_task/);
});
test('approval readback comes from persisted exact proposal and spells recipient', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input);
  const request = await f.capability.approvalRequest(ctx, p.proposalId);
  assert.equal(request.scope.digest, f.state.proposals.get(p.proposalId).digest);
  assert.equal(request.readback.body, input.body); assert.equal(request.readback.to, input.to);
  assert.equal(request.readback.recipientSpoken, 'r e c i p i e n t at e x a m p l e dot t e s t');
});
test('unheard control characters, malformed Unicode and long voice messages are rejected', async () => {
  const f = fixture();
  for (const body of ['hello\u202ehidden', 'hello\u200bworld', 'hello\ud800', 'a'.repeat(1501),
    'hello\ufe0f', 'hello\u{e0100}', 'hello\u3164', 'hello\u2028', 'hello\ue000']) {
    await assert.rejects(f.capability.prepare(ctx, { ...input, body }), /invalid_request/);
  }
});
test('known receipt tolerates provider Message-ID normalization and a display name', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.provider.read = async () => { const m = f.readback();
    m.payload.headers.find(h => h.name === 'Message-ID').value = '<provider-generated@example.test>';
    m.payload.headers.find(h => h.name === 'From').value = 'Demo Person <CALLER@example.test>';
    return m;
  };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verified');
});
test('readback with an extra recipient cannot verify', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.provider.read = async () => { const m = f.readback();
    m.payload.headers.find(h => h.name === 'To').value = 'other@example.test, Demo <recipient@example.test>'; return m; };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verification_pending');
});
test('durable worker executes and reconciles without a browser or live call session', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  const { sessionId, ...jobContext } = ctx;
  f.provider.send = async () => { f.state.sendCount++; throw new Error('timeout'); };
  assert.equal((await f.capability.executeApproved(jobContext, p.proposalId)).status, 'uncertain');
  assert.equal((await f.capability.reconcile({ ...jobContext, revision: 2 }, p.proposalId)).status, 'verified');
});
test('crash after durable claim can reconcile even before a receipt was persisted', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input);
  f.state.claimed.add(p.proposalId); f.state.outcomes.set(p.proposalId, { status: 'attempting' });
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'verified');
  assert.equal(f.state.sendCount, 0);
});
test('a broken claim contract blocks the external write', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.store.getOutcome = async () => null;
  await assert.rejects(f.capability.executeApproved(ctx, p.proposalId), /claim_outcome_required/);
  assert.equal(f.state.sendCount, 0);
});
test('verified outcomes cannot be downgraded by later draft edits', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, { ...input, action: 'save_draft' }); f.approve(p.proposalId);
  await f.capability.executeApproved(ctx, p.proposalId);
  f.provider.readDraft = async () => { throw new Error('user deleted draft'); };
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'verified');
});
test('definite Gmail rejection differs from uncertain transport failure', async () => {
  await assert.rejects(restFixture({ status: 403, data: { error: { code: 403 } } }).provider.send(binding(), { raw: 'test' }), /provider_rejected/);
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.provider.send = async () => { throw new GmailError('provider_rejected'); };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'rejected');
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'rejected');
});
test('lost session callback redirects cleanly and missing configured origin fails closed', async () => {
  const f = fixture();
  await withServer({ connections: f.connections, authenticate: async () => null, publicOrigin: 'https://errand.example.test' }, async base => {
    const response = await fetch(`${base}/api/connections/gmail/callback?session_uri=fictional`, { redirect: 'manual' });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/connections.html?connection=failed');
  });
  await withServer({ connections: f.connections, authenticate: async () => ctx }, async base => {
    assert.equal((await fetch(`${base}/api/connections/gmail/connect`, { method: 'POST', headers: { 'X-Errand-Intent': 'connect-gmail' } })).status, 503);
  });
});
test('a new connection to the same mailbox can reconcile an older claimed send', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.provider.send = async () => { throw new Error('timeout'); };
  await f.capability.executeApproved(ctx, p.proposalId);
  f.state.binding.accountId = 'ca_reconnected'; f.state.binding.bindingId = 'new-binding';
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'verified');
});
test('reconcile rejects an unclaimed scope or a different mailbox', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input);
  await assert.rejects(f.capability.reconcile(ctx, p.proposalId), /reconcile_not_authorized/);
  f.approve(p.proposalId); f.provider.send = async () => { throw new Error('timeout'); };
  await f.capability.executeApproved(ctx, p.proposalId);
  f.state.binding.email = 'other@example.test';
  await assert.rejects(f.capability.reconcile(ctx, p.proposalId), /connection_changed/);
});
test('an internally inconsistent raw MIME cannot be sent even if its digest was recomputed', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input);
  const changed = f.state.proposals.get(p.proposalId); changed.raw = 'changed';
  changed.digest = createHash('sha256').update(JSON.stringify([changed.id, changed.userId, changed.taskId,
    changed.revision, changed.accountId, changed.bindingId, changed.action, changed.from, changed.to,
    changed.subject, changed.body, changed.messageId, changed.date, changed.raw])).digest('hex');
  f.approve(p.proposalId);
  await assert.rejects(f.capability.executeApproved(ctx, p.proposalId), /proposal_changed/);
  assert.equal(f.state.sendCount, 0);
});
test('the example core store refuses reused revisions and new proposals during uncertainty', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input);
  await assert.rejects(f.capability.prepare(ctx, input), /stale_or_unresolved_task/);
  f.approve(p.proposalId); f.provider.send = async () => { throw new Error('timeout'); };
  await f.capability.executeApproved(ctx, p.proposalId);
  await assert.rejects(f.capability.prepare({ ...ctx, revision: 2 }, input), /stale_or_unresolved_task/);
});

// A small fictional generated PNG, independent of the MIME builder.
const pngBytes = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const imageAsset = () => ({ assetId: 'image-test', userId: ctx.userId, taskId: ctx.taskId,
  filename: 'greeting.png', mimeType: 'image/png', description: 'A tiny greeting image.', bytes: pngBytes() });
const imageInput = { ...input, attachmentAssetIds: ['image-test'] };

test('a full 5 MiB image fits the encoded MIME cap; one additional byte is rejected', async () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_RAW_BYTES, 10 * 1024 * 1024);
  // Synthetic bytes exercise the adapter's size boundary, not upstream image decoding.
  const asset = imageAsset(); asset.bytes = Buffer.alloc(MAX_IMAGE_BYTES); pngBytes().copy(asset.bytes);
  const f = fixture({ resolveImageAsset: async () => asset });
  const p = await f.capability.prepare(ctx, imageInput);
  assert.equal(p.attachments[0].size, MAX_IMAGE_BYTES);
  assert.ok(f.state.proposals.get(p.proposalId).raw.length <= MAX_RAW_BYTES);
  asset.bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1); pngBytes().copy(asset.bytes);
  await assert.rejects(f.capability.prepare({ ...ctx, revision: 2 }, imageInput), /invalid_image_size/);
});

test('image proposal creates multipart MIME and exposes metadata without bytes for approval', async () => {
  const asset = imageAsset(); let resolves = 0;
  const f = fixture({ resolveImageAsset: async (context, id) => {
    assert.equal(context.userId, ctx.userId); assert.equal(id, asset.assetId); resolves++; return asset;
  } });
  const p = await f.capability.prepare(ctx, imageInput);
  assert.equal(f.state.sendCount, 0);
  const saved = f.state.proposals.get(p.proposalId);
  const mime = Buffer.from(saved.raw, 'base64url').toString('utf8');
  const boundary = mime.match(/boundary="([^"]+)"/)[1];
  const parts = mime.split(`--${boundary}`);
  assert.equal(parts.length, 4); // headers, text, image, closing boundary
  assert.match(parts[1], /Content-Type: text\/plain; charset=UTF-8/);
  assert.equal(Buffer.from(parts[1].split('\r\n\r\n')[1].trim(), 'base64').toString(), input.body);
  assert.match(parts[2], /Content-Type: image\/png\r\nContent-Disposition: attachment; filename="greeting.png"/);
  assert.deepEqual(Buffer.from(parts[2].split('\r\n\r\n')[1].trim(), 'base64'), pngBytes());
  assert.match(parts[3], /^--\r\n$/);
  assert.ok(mime.split('\r\n').every(line => line.length <= 998));
  const approval = await f.capability.approvalRequest(ctx, p.proposalId);
  assert.deepEqual(approval.readback.attachments, p.attachments);
  assert.equal(p.attachments[0].sha256, createHash('sha256').update(pngBytes()).digest('hex'));
  assert.equal(p.attachments[0].description, asset.description);
  assert.equal('data' in p.attachments[0], false);
  // Source changes after proposal cannot change the approved bytes or trigger another resolve.
  asset.bytes.fill(0); asset.description = 'Changed image';
  let sentRaw;
  f.provider.send = async (_binding, message) => { sentRaw = message.raw; return { id: 'message-test' }; };
  f.approve(p.proposalId);
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verified');
  assert.equal(sentRaw, saved.raw); assert.equal(resolves, 1);
});

test('image draft is verified using Gmail attachment bytes fetched through its message ID', async () => {
  const f = fixture({ resolveImageAsset: async () => imageAsset() });
  const p = await f.capability.prepare(ctx, { ...imageInput, action: 'save_draft' });
  f.provider.readDraft = async () => {
    const message = f.readback(); message.payload.parts[1].body = { size: pngBytes().length, attachmentId: 'attachment-test' };
    return { id: 'draft-test', message };
  };
  let reads = 0;
  f.provider.readAttachment = async (b, messageId, attachmentId) => {
    reads++; assert.equal(b.accountId, 'ca_test'); assert.equal(messageId, 'message-test'); assert.equal(attachmentId, 'attachment-test');
    return { size: pngBytes().length, data: pngBytes().toString('base64url') };
  };
  f.approve(p.proposalId);
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verified');
  assert.equal(reads, 1); assert.equal(f.state.draftCount, 1); assert.equal(f.state.sendCount, 0);
});

for (const [name, mutate, code] of [
  ['owner', a => a.userId = 'another-user', 'image_asset_not_authorized'], ['task', a => a.taskId = 'another-task', 'image_asset_not_authorized'],
  ['asset ID', a => a.assetId = 'another-image', 'image_asset_not_authorized'], ['empty bytes', a => a.bytes = Buffer.alloc(0), 'invalid_image_size'],
  ['oversize', a => a.bytes = Buffer.alloc(5 * 1024 * 1024 + 1), 'invalid_image_size'],
  ['HTML', a => { a.mimeType = 'text/html'; a.filename = 'image.html'; }, 'invalid_image_type'],
  ['spoofed PNG', a => a.bytes = Buffer.from('<script>fake image</script>'), 'invalid_image_type'],
  ['extension', a => a.filename = 'image.jpg', 'invalid_image_filename'], ['header injection', a => a.filename = 'a.png\r\nBcc: somebody', 'invalid_image_filename'],
  ['path', a => a.filename = '../a.png', 'invalid_image_filename'], ['Unicode filename', a => a.filename = 'café.png', 'invalid_image_filename'],
  ['description control', a => a.description = 'nice\u202Ehidden', 'invalid_image_description'], ['missing description', a => delete a.description, 'invalid_image_description'],
]) test(`image asset rejects ${name} before persisting or sending`, async () => {
  const asset = imageAsset(); mutate(asset);
  const f = fixture({ resolveImageAsset: async () => asset });
  await assert.rejects(f.capability.prepare(ctx, imageInput), e => e instanceof GmailError && e.code === code);
  assert.equal(f.state.proposals.size, 0); assert.equal(f.state.sendCount, 0);
});

test('image requests reject unconfigured resolver, arbitrary URLs/bytes and multiple assets', async () => {
  const f = fixture();
  await assert.rejects(f.capability.prepare(ctx, imageInput), /image_assets_not_configured/);
  for (const [attachmentAssetIds, code] of [[['https://example.test/image.png'], 'invalid_request'], [['one', 'two'], 'invalid_image_assets'], ['image-test', 'invalid_image_assets']]) {
    await assert.rejects(f.capability.prepare(ctx, { ...input, attachmentAssetIds }), e => e instanceof GmailError && e.code === code);
  }
  for (const key of ['attachments', 'imageUrl', 'imageBytes']) {
    await assert.rejects(f.capability.prepare(ctx, { ...input, [key]: 'untrusted' }), /invalid_request/);
  }
  assert.equal(f.state.proposals.size, 0);
});

for (const [name, mutate] of [
  ['bytes', part => part.body.data = Buffer.alloc(pngBytes().length, 1).toString('base64url')],
  ['filename', part => part.filename = 'other.png'], ['type', part => part.mimeType = 'image/jpeg'],
  ['size', part => part.body.size++], ['invalid encoding', part => part.body.data = '!not-base64!'],
]) test(`readback cannot verify image with mismatched ${name}`, async () => {
  const f = fixture({ resolveImageAsset: async () => imageAsset() });
  const p = await f.capability.prepare(ctx, imageInput); f.approve(p.proposalId);
  f.provider.read = async () => { const m = f.readback(); mutate(m.payload.parts[1]); return m; };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verification_pending');
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'uncertain');
  assert.equal(f.state.sendCount, 1);
});

test('missing or extra image parts cannot pass readback, including unexpected images on text-only mail', async () => {
  for (const mode of ['missing', 'extra', 'text-only']) {
    const f = fixture({ resolveImageAsset: async () => imageAsset() });
    const p = await f.capability.prepare(ctx, mode === 'text-only' ? input : imageInput); f.approve(p.proposalId);
    f.provider.read = async () => {
      const m = f.readback();
      if (mode === 'missing') m.payload.parts.pop();
      else if (mode === 'extra') m.payload.parts.push(structuredClone(m.payload.parts[1]));
      else { m.payload.parts = [{ mimeType: 'text/plain', body: m.payload.body }, { mimeType: 'image/png', filename: 'extra.png' }]; m.payload.mimeType = 'multipart/mixed'; delete m.payload.body; }
      return m;
    };
    assert.equal(await verifyImages(f.provider, binding(), await f.provider.read(), f.state.proposals.get(p.proposalId).images), false);
    assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verification_pending');
  }
});

test('nullable database image column preserves existing text-only proposals', async () => {
  const f = fixture(); const p = await f.capability.prepare(ctx, input); f.approve(p.proposalId);
  f.state.proposals.get(p.proposalId).images = null;
  const approval = await f.capability.approvalRequest(ctx, p.proposalId);
  assert.equal(approval.attachmentRequiresExplicitConfirmation, false);
  assert.deepEqual(approval.readback.attachments, []);
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verified');
});

test('composition passes the asset resolver into the Gmail prepare capability', async () => {
  const f = fixture(); let resolves = 0;
  const integration = createGmailIntegration({ apiKey: 'fictional-key', authConfigId: 'ac_test', publicOrigin: 'https://errand.example.test',
    store: f.store, approvalGate: { claim: async () => false, canReconcile: async () => false }, authorizeRead: async () => true,
    resolveImageAsset: async () => { resolves++; return imageAsset(); },
    fetchImpl: async () => new Response(JSON.stringify(active()), { status: 200 }),
  });
  const p = await integration.capability.prepare(ctx, imageInput);
  assert.equal(resolves, 1); assert.equal(p.attachments[0].filename, 'greeting.png');
});

test('unknown image send reconciles by Message-ID without resolving or sending the source again', async () => {
  const asset = imageAsset(); let resolves = 0;
  const f = fixture({ resolveImageAsset: async () => { resolves++; return asset; } });
  const p = await f.capability.prepare(ctx, imageInput); f.approve(p.proposalId);
  f.provider.send = async () => { f.state.sendCount++; throw new Error('receipt lost'); };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'uncertain');
  assert.equal(f.state.outcomes.get(p.proposalId).providerId, undefined);
  asset.bytes.fill(0);
  assert.equal((await f.capability.reconcile(ctx, p.proposalId)).status, 'verified');
  assert.equal(resolves, 1); assert.equal(f.state.sendCount, 1);
});

test('REST sends raw MIME directly and nests raw MIME only for draft creation', async () => {
  const { provider, calls } = restFixture({ status: 200, data: { id: 'message-test' } });
  await provider.send(binding(), { raw: 'ZmljdGlvbmFs' });
  await provider.saveDraft(binding(), { raw: 'ZmljdGlvbmFs' });
  const requests = calls.map(call => JSON.parse(call.options.body));
  assert.deepEqual(requests[0].body, { raw: 'ZmljdGlvbmFs' });
  assert.deepEqual(requests[1].body, { message: { raw: 'ZmljdGlvbmFs' } });
  assert.equal(requests[0].endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(requests[1].endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts');
  assert.ok(requests.every(r => r.method === 'POST'));
});

test('attachment read outage reconciles without a second send, including after caller hangs up', async () => {
  const f = fixture({ resolveImageAsset: async () => imageAsset() });
  const p = await f.capability.prepare(ctx, imageInput); f.approve(p.proposalId);
  f.provider.read = async () => {
    const m = f.readback(); m.payload.parts[1].body = { size: pngBytes().length, attachmentId: 'attachment-test' }; return m;
  };
  f.provider.readAttachment = async () => { throw new Error('timeout'); };
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'uncertain');
  f.provider.readAttachment = async () => ({ size: pngBytes().length, data: pngBytes().toString('base64url') });
  assert.equal((await f.capability.reconcile({ ...ctx, sessionId: undefined }, p.proposalId)).status, 'verified');
  await assert.rejects(f.capability.executeApproved(ctx, p.proposalId), /already_claimed/);
  assert.equal(f.state.sendCount, 1);
});

test('image metadata or data tampering invalidates the proposal approval', async () => {
  for (const key of ['description', 'data', 'sha256', 'filename']) {
    const f = fixture({ resolveImageAsset: async () => imageAsset() });
    const p = await f.capability.prepare(ctx, imageInput); f.approve(p.proposalId);
    f.state.proposals.get(p.proposalId).images[0][key] = 'changed';
    await assert.rejects(f.capability.executeApproved(ctx, p.proposalId), /proposal_changed/);
    assert.equal(f.state.sendCount, 0);
  }
});

test('REST image download is pinned to the bound Gmail message, including long opaque attachment IDs', async () => {
  const { provider, calls } = restFixture({ status: 200, data: { size: 3, data: 'YWJj' } });
  const id = 'a'.repeat(800);
  await provider.readAttachment(binding(), 'message-test', id);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.endpoint, `https://gmail.googleapis.com/gmail/v1/users/me/messages/message-test/attachments/${id}`);
  assert.equal(body.method, 'GET'); assert.equal(body.connected_account_id, 'ca_test'); assert.equal(body.user_id, ctx.userId);
  await assert.rejects(async () => provider.readAttachment(binding(), 'message-test', '../other'), /invalid_request/);
  assert.equal(calls.length, 1);
});

test('strict prepare tool has a required nullable image field and keeps bytes out of tool schema', () => {
  const schema = gmailTools.find(t => t.name === 'gmail_prepare').parameters;
  assert.deepEqual(schema.properties.attachmentAssetIds.type, ['array', 'null']);
  assert.ok(schema.required.includes('attachmentAssetIds'));
  assert.equal(schema.additionalProperties, false);
});

test('image approval survives database JSON object key reordering', async () => {
  const f = fixture({ resolveImageAsset: async () => imageAsset() });
  const p = await f.capability.prepare(ctx, imageInput); f.approve(p.proposalId);
  const saved = f.state.proposals.get(p.proposalId);
  saved.images[0] = Object.fromEntries(Object.entries(saved.images[0]).reverse());
  const approval = await f.capability.approvalRequest(ctx, p.proposalId);
  assert.equal(approval.attachmentRequiresExplicitConfirmation, true);
  assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verified');
});

test('attachment structure overflow and unnamed attachment IDs cannot hide additional parts', async () => {
  for (const mode of ['depth', 'nodes', 'unnamed']) {
    const f = fixture({ resolveImageAsset: async () => imageAsset() });
    const p = await f.capability.prepare(ctx, imageInput); f.approve(p.proposalId);
    f.provider.read = async () => {
      const m = f.readback();
      if (mode === 'depth') for (let n = 0; n < 11; n++) m.payload.parts = [{ mimeType: 'multipart/mixed', parts: m.payload.parts }];
      else if (mode === 'nodes') m.payload.parts.push(...Array.from({ length: 30 }, () => ({ mimeType: 'text/plain', body: {} })));
      else m.payload.parts.push({ mimeType: 'text/plain', body: { attachmentId: 'hidden' } });
      return m;
    };
    assert.equal(await verifyImages(f.provider, binding(), await f.provider.read(), f.state.proposals.get(p.proposalId).images), false);
    assert.equal((await f.capability.executeApproved(ctx, p.proposalId)).status, 'verification_pending');
  }
});
