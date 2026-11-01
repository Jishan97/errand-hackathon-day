import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, handleImageGeneration, DEFAULT_IMAGE_MODEL } from '../src/images/generate.js';
import { createApp } from '../src/app.js';

const token = 'fictional_test_operator_token_1234567890';
const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]); // Protocol fixture; not presented as an actual generated picture.
const request = (body = { prompt: 'A friendly dragon on a bicycle' }, options = {}) => new Request('https://errand.example.test/api/images/generate', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  body: JSON.stringify(body),
});
const opts = (generate) => ({ getToken: () => token, getConfig: () => ({ apiKey: 'fictional-key' }), generate });

test('generator sends one bounded server-configured request and returns JPEG bytes', async () => {
  const calls = [];
  const image = await generateImage({ prompt: ' A birthday card ', apiKey: 'fictional-key', fetcher: async (url, init) => {
    calls.push({ url, init }); return Response.json({ data: [{ b64_json: jpeg.toString('base64') }] });
  } });
  assert.deepEqual(image.bytes, jpeg); assert.equal(image.contentType, 'image/jpeg');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: DEFAULT_IMAGE_MODEL, prompt: 'A birthday card', n: 1,
    size: '1024x1024', quality: 'low', output_format: 'jpeg', output_compression: 80 });
});
test('explicit server model is respected without fallback', async () => {
  await generateImage({ prompt: 'A garden', apiKey: 'fictional', model: 'gpt-image-2', fetcher: async (_, init) => {
    assert.equal(JSON.parse(init.body).model, 'gpt-image-2'); return Response.json({ data: [{ b64_json: jpeg.toString('base64') }] });
  } });
});
test('prompt and missing configuration validation happen before provider access', async () => {
  for (const prompt of ['', '  ', null, 'a'.repeat(2001), 'hidden\0text', '\ud800']) {
    await assert.rejects(generateImage({ prompt, apiKey: 'fictional', fetcher: () => assert.fail('must not call') }), /invalid_prompt/);
  }
  await assert.rejects(generateImage({ prompt: 'A garden' }), /image_setup_required/);
});
for (const [status, code, expected] of [[400, 'moderation_blocked', 'image_request_blocked'],
  [429, 'rate_limit_exceeded', 'image_rate_limited'], [403, 'denied', 'image_access_required'],
  [500, 'private details', 'image_provider_unavailable']]) {
  test(`provider ${status} maps to safe ${expected}`, async () => {
    await assert.rejects(generateImage({ prompt: 'A picture', apiKey: 'fictional', fetcher: async () => Response.json({ error: { code, message: 'private' } }, { status }) }), new RegExp(expected));
  });
}
test('timeout or transport failure never retries or leaks provider text', async () => {
  for (const error of [new DOMException('timed out', 'TimeoutError'), new Error('private headers')]) {
    let calls = 0;
    await assert.rejects(generateImage({ prompt: 'A picture', apiKey: 'fictional', fetcher: async () => { calls++; throw error; } }),
      new RegExp(error.name === 'TimeoutError' ? 'image_generation_timed_out' : 'image_provider_unavailable'));
    assert.equal(calls, 1);
  }
});
test('malformed provider output is rejected rather than returning a fake success', async () => {
  for (const data of [{}, { data: [] }, { data: [{ url: 'https://example.test/image' }] },
    { data: [{ b64_json: 'not base64!' }] }, { data: [{ b64_json: Buffer.from('not jpeg').toString('base64') }] }]) {
    await assert.rejects(generateImage({ prompt: 'A picture', apiKey: 'fictional', fetcher: async () => Response.json(data) }), /image_provider_unavailable/);
  }
});
test('streamed provider response size is bounded', async () => {
  await assert.rejects(generateImage({ prompt: 'A picture', apiKey: 'fictional', fetcher: async () => new Response(' '.repeat(5 * 1024 * 1024 + 1)) }), /image_response_too_large/);
});
test('unauthenticated or rejected calls never reach generation', async () => {
  const never = opts(() => assert.fail('generation must not run'));
  assert.equal((await handleImageGeneration(new Request('https://errand.example.test/api/images/generate', { method: 'POST' }), never)).status, 401);
  assert.equal((await handleImageGeneration(request({}, { headers: { Authorization: `Bearer ${'x'.repeat(40)}` } }), never)).status, 403);
  assert.equal((await handleImageGeneration(request())).status, 503);
  assert.equal((await handleImageGeneration(new Request('https://errand.example.test/api/images/generate'), never)).status, 405);
});
test('body cannot select model, destination or credentials', async () => {
  for (const body of [{ prompt: 'A picture', model: 'other' }, { prompt: 'A picture', apiKey: 'key' }, [], null]) {
    assert.equal((await handleImageGeneration(request(body), opts(() => assert.fail('must not call')))).status, 400);
  }
});
test('streamed request limit and bad JSON/content type fail closed', async () => {
  assert.equal((await handleImageGeneration(request({ prompt: 'a'.repeat(10001) }), opts())).status, 413);
  assert.equal((await handleImageGeneration(request({}, { headers: { 'Content-Type': 'text/plain' } }), opts())).status, 415);
  const malformed = new Request('https://errand.example.test/api/images/generate', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await handleImageGeneration(malformed, opts())).status, 400);
});
test('successful HTTP response is downloadable binary and no-store', async () => {
  const response = await handleImageGeneration(request(), opts(async args => {
    assert.equal(args.apiKey, 'fictional-key'); return { bytes: jpeg, contentType: 'image/jpeg', filename: 'errand-image.jpg' };
  }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-disposition').includes('errand-image.jpg'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
});
test('local app serves image screen and leaves provider disabled by default', async () => {
  const server = createApp(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/image.html`)).status, 200);
    assert.equal((await fetch(`${base}/image.js`)).status, 200);
    assert.equal((await fetch(`${base}/incident.html`)).status, 200);
    assert.equal((await fetch(`${base}/api/images/generate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
