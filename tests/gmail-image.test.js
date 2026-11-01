import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createImageGenerator, sanitizeGeneratedPng, runImageAgent, IMAGE_MODEL } from '../src/agents/gmail-image.js';
import { handleGmailDemo } from '../src/core/gmail-http.js';
import { createGmailAuth } from '../src/core/gmail-auth.js';

const context = { userId: 'operator-demo', taskId: '22222222-2222-4222-8222-222222222222', revision: 1 };
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
function fixture() {
  const assets = new Map(), calls = []; let claimed = false;
  const state = { task: context, fail: false, caption: 'A small white square.', writes: 0 };
  const store = { getTask: async () => state.task,
    resolveImageAsset: async (_, id) => assets.get(id),
    putImageAsset: async asset => { state.writes++; assets.set(asset.assetId, asset); return true; } };
  const generate = createImageGenerator({ apiKey: 'fictional-key', store,
    claim: async () => { if (claimed) return false; claimed = true; return true; },
    fetcher: async (url, options) => { calls.push({ url, ...options }); if (state.fail) throw Error('private provider content');
      return Response.json({ data: [{ b64_json: png.toString('base64') }] }); },
    describeClient: { responses: { create: async input => {
      state.captionInput = input; return { status: 'completed', output_text: state.caption };
    } } },
  });
  return { generate, assets, calls, state };
}

test('generated image is sanitized, visually described, saved and replayed without another paid call', async () => {
  const f = fixture(); const args = { prompt: 'A white square' };
  f.state.caption = 'A small\nwhite square.';
  const image = await f.generate(context, args);
  assert.equal(f.calls.length, 1); assert.equal(f.state.writes, 1);
  assert.equal(JSON.parse(f.calls[0].body).model, IMAGE_MODEL);
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(image.description, 'A small white square.'); assert.equal(image.data, undefined); assert.equal(image.bytes, undefined);
  assert.deepEqual(f.state.captionInput.reasoning, { effort: 'low' });
  const saved = f.assets.get(image.assetId);
  assert.equal(saved.bytes.includes(Buffer.from('private metadata')), false);
  assert.equal(f.state.captionInput.input[0].content[0].image_url, `data:image/png;base64,${saved.bytes.toString('base64')}`);
  assert.deepEqual(await f.generate(context, args), image);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.generate(context, { prompt: 'A different image' }), /already_attempted/);
});

test('generation fails closed on stale ownership, malformed arguments and uncertain provider errors', async () => {
  const f = fixture();
  await assert.rejects(f.generate({ ...context, userId: 'other' }, { prompt: 'Image' }), /stale/);
  await assert.rejects(f.generate(context, { prompt: 'Image', userId: 'other' }), /invalid_image_prompt/);
  assert.equal(f.calls.length, 0);
  f.state.fail = true;
  await assert.rejects(f.generate(context, { prompt: 'Image' }), e => e.message === 'image_generation_unconfirmed');
  await assert.rejects(f.generate(context, { prompt: 'Image' }), /already_attempted/);
  assert.equal(f.calls.length, 1); assert.equal(f.state.writes, 0);
});

test('concurrent image requests claim once and reject unsafe captions before persistence', async () => {
  const f = fixture(); f.state.caption = 'x'.repeat(401);
  const results = await Promise.allSettled([f.generate(context, { prompt: 'Image' }), f.generate(context, { prompt: 'Image' })]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 2);
  assert.equal(f.calls.length, 1); assert.equal(f.state.writes, 0);
});

test('PNG decoder rejects malformed data, oversized inputs and excessive dimensions', () => {
  assert.throws(() => sanitizeGeneratedPng(Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')), /invalid_image_size/);
  assert.throws(() => sanitizeGeneratedPng('invalid!'), /invalid_image_size/);
  const huge = Buffer.from(png); huge.writeUInt32BE(1000000, 16);
  assert.throws(() => sanitizeGeneratedPng(huge.toString('base64')), /invalid_image_dimensions/);
  const corrupt = Buffer.from(png); corrupt[30] ^= 255;
  assert.throws(() => sanitizeGeneratedPng(corrupt.toString('base64')), /invalid_image_type/);
  assert.throws(() => sanitizeGeneratedPng(Buffer.concat([png, Buffer.from('trailing payload')]).toString('base64')), /invalid_image_type/);
});

test('Agents API round trip executes only validated required_action and returns metadata to session', async () => {
  const calls = [], output = { assetId: 'saved', description: 'A white square.' };
  const sessions = { create: async input => { calls.push(input); return { id: 'session_1', required_actions: [{ type: 'function_call',
    name: 'generate_task_image', call_id: 'call_1', turn_id: 'turn_1', arguments: { prompt: 'Image' } }] }; },
    events: { create: async (...args) => calls.push(args) },
    retrieve: async () => ({ id: 'session_1', status: 'idle' }),
    turns: { list: async () => ({ data: [{ session_id: 'session_1', status: 'cancelled' }], has_more: false }) },
    delete: async () => { calls.push('deleted'); return { id: 'session_1', deleted: true }; } };
  let executions = 0;
  const result = await runImageAgent({ apiKey: 'fictional-key', prompt: 'Image', createClient: () => ({ beta: { agents: { sessions } } }),
    generate: async args => { executions++; assert.deepEqual(args, { prompt: 'Image' }); return output; } });
  assert.equal(calls[0].agent.model, 'gpt-6.1-sol'); assert.equal(calls[0].agent.tools[0].name, 'generate_task_image');
  assert.equal(executions, 1); assert.deepEqual(result, output);
  assert.equal(calls[1][1].events[0].output, JSON.stringify(output)); assert.equal(calls.at(-1), 'deleted');
  const logs = [];
  sessions.events.create = async () => { throw Error('private error'); };
  assert.deepEqual(await runImageAgent({ apiKey: 'fictional-key', prompt: 'Image', createClient: () => ({ beta: { agents: { sessions } } }),
    generate: async () => output, logger: entry => logs.push(entry) }), output);
  assert.deepEqual(logs, [{ event: 'image_tool_result_submission_unconfirmed' }]);
  sessions.create = async () => ({ id: 'session_1', required_actions: [{ type: 'function_call', name: 'gmail_send', arguments: {} }] });
  await assert.rejects(runImageAgent({ apiKey: 'fictional-key', prompt: 'Image', createClient: () => ({ beta: { agents: { sessions } } }),
    generate: async () => { executions++; } }), /invalid_image_agent_action/);
  assert.equal(executions, 1);
});

test('image operator route requires authenticated same-origin session and server-owned task', async () => {
  const token = 'fictional_operator_token_'.repeat(2), origin = 'https://errand.example.test';
  const cookie = createGmailAuth({ token }).login(`Bearer ${token}`).split(';')[0]; let count = 0;
  const options = { getValues: () => ({ ENABLE_GMAIL_DEMO: 'true', PUBLIC_BASE_URL: origin, OPERATOR_TOKEN: token }),
    createRuntime: () => ({ store: { getTask: async () => context }, generateImage: async (task, prompt) => {
      assert.deepEqual(task, context); assert.equal(prompt, 'Image'); count++; return { assetId: 'saved' };
    } }) };
  const request = (headers = {}, body = { taskId: context.taskId, prompt: 'Image' }) => new Request(`${origin}/api/gmail/generate-image`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Errand-Intent': 'gmail-demo', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await handleGmailDemo(request({ Cookie: '' }), options)).status, 401);
  assert.equal((await handleGmailDemo(request({ Origin: 'https://other.example.test' }), options)).status, 403);
  assert.equal((await handleGmailDemo(request({}, { taskId: context.taskId, prompt: 'Image', userId: 'other' }), options)).status, 400);
  assert.equal((await handleGmailDemo(request(), options)).status, 200); assert.equal(count, 1);
});
