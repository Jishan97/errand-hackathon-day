import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createComposioGmail, GmailError } from '../src/integrations/gmail/composio.js';
import { createGmailIntegration } from '../src/integrations/gmail/index.js';
import { createGmailConnections } from '../src/integrations/gmail/connections.js';
import { createGmailCapability, bindGmailTools } from '../src/integrations/gmail/capability.js';
import { createApp } from '../src/app.js';

// Entirely fictional fixtures. Memory state exists ONLY in tests, never in the app.
const ctx = { userId: 'test-user', sessionId: 'test-session', taskId: 'test-task', revision: 1 };
const active = () => ({ id: 'ca_test', user_id: ctx.userId, toolkit: { slug: 'gmail' },
  status: 'ACTIVE', is_disabled: false, auth_config: { id: 'ac_test', is_disabled: false, is_composio_managed: true } });
const binding = () => ({ userId: ctx.userId, accountId: 'ca_test', bindingId: 'binding-test', email: 'caller@example.test' });
const input = { action: 'send', to: 'recipient@example.test', subject: 'Repair appointment', body: 'Friday after three, please.' };
function fixture() {
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
    return { id: 'message-test', labelIds: ['SENT'], payload: { mimeType: 'text/plain',
      headers: Object.entries({ From: p.from, To: p.to, Subject: p.subject, 'Message-ID': p.messageId }).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(p.body).toString('base64url') } } };
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
  const capability = createGmailCapability({ provider, store, connections, approvalGate, authorizeRead: async c => c.userId === ctx.userId });
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
