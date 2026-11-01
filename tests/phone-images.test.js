import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPhoneImages, createImageStore } from '../src/images/phone.js';
import { handleImageDisplay } from '../src/images/display.js';
import { createAssistantService } from '../src/phone/assistant/service.js';
import { validateAction, actionHash, describeAction } from '../src/phone/assistant/tools.js';

const callSid = `CA${'a'.repeat(32)}`, token = 'fictional_test_operator_token_1234567890';
const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
function fixture() {
  const rows = new Map(), work = []; let generations = 0;
  const store = {
    stage: async row => { rows.set(row.id, { ...row }); return row; },
    claim: async (_sid, proposal) => {
      const row = rows.get(proposal.id);
      if (!row || row.status !== 'proposed' || proposal.hash !== row.hash || proposal.nonce !== row.nonce) throw Error('claimed');
      row.status = 'running'; return { ...row };
    },
    finish: async (id, result) => Object.assign(rows.get(id), result),
    decline: async (_sid, id) => { rows.get(id).status = 'declined'; },
    latest: async () => [...rows.values()].at(-1), image: async id => rows.get(id)?.image_base64,
  };
  const images = createPhoneImages({ store, apiKey: 'fictional', schedule: task => work.push(task),
    generate: async ({ prompt }) => { generations++; assert.equal(prompt, 'A cat with balloons'); return { bytes: jpeg }; } });
  const repository = { context: async () => ({ profile: { timeZone: 'Europe/London' }, tasks: [] }),
    stage: () => assert.fail('image proposal must not use reminder storage') };
  const service = createAssistantService({ config: { values: { OPENAI_API_KEY: 'fictional' }, agentModel: 'gpt-6.1-sol' }, repository, images,
    planner: async () => ({ kind: 'propose', operation: 'generate_image',
      args: { title: 'A cat with balloons', dueAt: null, taskId: null, revision: null }, sourceEventIds: ['caller-test'] }),
    assessor: async () => ({ decision: 'confirm', sourceEventIds: ['caller-yes'] }) });
  return { store, images, service, rows, work, generations: () => generations };
}
test('phone request follows shared planning/readback/consent path then publishes bytes to the screen', async () => {
  const f = fixture();
  assert.ok((await f.service.context(callSid)).capabilities.includes('generate_image'));
  const plan = await f.service.plan({ callSid, history: [], isCurrent: () => true });
  assert.equal(plan.kind, 'propose'); assert.match(plan.proposal.summary, /A cat with balloons/);
  assert.equal(f.generations(), 0);
  const result = await f.service.confirm({ callSid, proposal: plan.proposal, readbackText: plan.proposal.summary,
    replyHistory: [], isCurrent: () => true });
  assert.equal(result.status, 'confirmed'); assert.equal(result.taskStatus, 'running');
  await Promise.all(f.work);
  const status = await handleImageDisplay(new Request('https://example.test/api/images/latest', { headers: { Authorization: `Bearer ${token}` } }),
    { getToken: () => token, getStore: () => f.store });
  const latest = (await status.json()).image; assert.equal(latest.status, 'ready'); assert.equal(latest.id, result.taskId);
  const image = await handleImageDisplay(new Request(`https://example.test/api/images/result?id=${result.taskId}`, { headers: { Authorization: `Bearer ${token}` } }),
    { getToken: () => token, getStore: () => f.store });
  assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  await assert.rejects(f.images.confirm({ callSid, proposal: plan.proposal }), /claimed/);
  assert.equal(f.generations(), 1);
});
test('no current consent or declined image proposal cannot start generation', async () => {
  const f = fixture(); const { proposal } = await f.service.plan({ callSid, history: [] });
  assert.equal((await f.service.confirm({ callSid, proposal, readbackText: proposal.summary, replyHistory: [], isCurrent: () => false })).status, 'stale');
  assert.equal(f.generations(), 0);
  await f.service.decline(callSid, proposal.id, 'generate_image');
  await assert.rejects(f.images.confirm({ callSid, proposal }), /claimed/);
});
test('image operation is disabled unless server capability exists', () => {
  assert.throws(() => validateAction('generate_image', { title: 'A cat' }), /image_tools_unavailable/);
  assert.deepEqual(validateAction('generate_image', { title: 'A cat' }, { imageEnabled: true }), { title: 'A cat' });
});
test('phone-screen status and bytes require operator authorization', async () => {
  const response = await handleImageDisplay(new Request('https://example.test/api/images/latest'), { getStore: () => assert.fail('no storage access') });
  assert.equal(response.status, 401);
});
test('transport failure after claim remains uncertain and is not regenerated', async () => {
  const f = fixture(); let calls = 0;
  const images = createPhoneImages({ store: f.store, schedule: promise => f.work.push(promise), generate: async () => { calls++; throw Error('network'); } });
  const args = { title: 'A cat with balloons' }, summary = describeAction('generate_image', args);
  const proposal = await images.stage({ callSid, args, summary, hash: actionHash('generate_image', args, summary), nonce: randomUUID() });
  await images.confirm({ callSid, proposal }); await Promise.all(f.work);
  assert.equal((await f.store.latest()).status, 'uncertain');
  await assert.rejects(images.confirm({ callSid, proposal }), /claimed/); assert.equal(calls, 1);
});
test('REST claim binds call hash, proposal, nonce, digest, expiry and proposed status atomically', async () => {
  const calls = [], id = randomUUID(), nonce = randomUUID(), hash = 'b'.repeat(64);
  const store = createImageStore({ url: 'https://example.supabase.co', secret: 'sb_secret_fictional', fetcher: async (url, init) => {
    calls.push({ url: new URL(url), init }); return Response.json([{ id, nonce, hash, prompt: 'A cat', status: 'running' }]);
  } });
  await store.claim(callSid, { id, nonce, hash });
  const { url, init } = calls[0]; assert.equal(init.method, 'PATCH');
  assert.equal(url.searchParams.get('status'), 'eq.proposed'); assert.equal(url.searchParams.get('nonce'), `eq.${nonce}`);
  assert.equal(url.searchParams.get('hash'), `eq.${hash}`); assert.match(url.searchParams.get('call_hash'), /^eq\.[a-f0-9]{64}$/);
  assert.ok(url.searchParams.has('created_at')); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, undefined);
});
test('REST empty claim cannot execute or reset an existing run', async () => {
  const store = createImageStore({ url: 'https://example.supabase.co', secret: 'fictional', fetcher: async () => Response.json([]) });
  await assert.rejects(store.claim(callSid, { id: randomUUID(), nonce: randomUUID(), hash: 'c'.repeat(64) }), /already_claimed/);
});
