import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import deployedHandler from '../api/webhooks/sentry.js';
import { handleSentryWebhook, MAX_BODY_BYTES, parseSentryAlert } from '../src/integrations/sentry-webhook.js';

// Fictional fixtures only. Nothing reads a private file or actual configuration.
const webhookSecret = 'fixture-not-a-real-sentry-client-secret';
const projectId = '123';
const release = 'a'.repeat(40);
const privateText = 'fictional-private-marker-must-not-escape';
const settings = { webhookSecret, projectId };
const event = (patch = {}) => ({ action: 'triggered', actor: { email: privateText }, data: { event: {
  project: projectId, issue_id: '321', release, tags: [['errand_demo', 'upload_lf_v1']],
  request: { data: privateText }, stacktrace: privateText, url: `https://example.invalid/${privateText}`,
  ...patch,
} } });
const sign = (body) => createHmac('sha256', webhookSecret).update(body).digest('hex');

function request({ payload = event(), raw = JSON.stringify(payload), signature = sign(raw),
  resource = 'event_alert', url = 'https://example.invalid/api/webhooks/sentry',
  method = 'POST', headers = {} } = {}) {
  return new Request(url, { method, headers: { 'content-type': 'application/json',
    'sentry-hook-signature': signature, 'sentry-hook-resource': resource, ...headers },
  ...(!['GET', 'HEAD'].includes(method) ? { body: raw } : {}) });
}

const options = (onVerified = () => {}) => ({ getConfig: () => settings, onVerified });

test('verifies exact whitespace/Unicode bytes and exposes only a sanitized receipt', async () => {
  const raw = JSON.stringify({ ...event(), ignored: 'fictional café 🌿' }, null, 2);
  const receipts = [];
  const response = await handleSentryWebhook(request({ raw }), options((receipt) => { receipts.push(receipt); }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const receipt = await response.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['processing', 'receiptId', 'status']);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.processing, 'not_connected');
  assert.match(receipt.receiptId, /^[a-f0-9]{32}$/);
  assert.deepEqual(receipts, [receipt]);
  const output = JSON.stringify(receipts);
  for (const forbidden of [webhookSecret, privateText, release, '321', 'https://']) assert.ok(!output.includes(forbidden));

  const normalized = parseSentryAlert({ body: Buffer.from(raw), signature: sign(raw),
    resource: 'event_alert', ...settings });
  assert.deepEqual(normalized.details, { issueId: '321', baseSha: release, fixture: 'upload_lf_v1' });
  assert.ok(!JSON.stringify(normalized).includes(privateText));
});

test('changed raw bytes and a wrong signing key are rejected without invoking the receipt hook', async () => {
  const original = JSON.stringify(event());
  let calls = 0;
  for (const input of [
    request({ raw: `${original}\n`, signature: sign(original) }),
    request({ signature: '0'.repeat(64) }),
  ]) {
    const response = await handleSentryWebhook(input, options(() => { calls++; }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'invalid_sentry_signature' });
  }
  assert.equal(calls, 0);
});

test('the reusable MVP parser rejects malformed direct-call inputs before timing comparison', () => {
  const raw = Buffer.from(JSON.stringify(event()));
  for (const patch of [{ signature: 'a' }, { signature: ['a'.repeat(64)] },
    { body: JSON.stringify(event()) }, { body: Buffer.alloc(MAX_BODY_BYTES + 1) }]) {
    assert.throws(() => parseSentryAlert({ body: raw, signature: sign(raw), resource: 'event_alert',
      ...settings, ...patch }), { message: 'invalid_sentry_signature' });
  }
});

test('missing/malformed signatures and unsupported methods never access configuration', async () => {
  let reads = 0;
  const guarded = { getConfig() { reads++; throw Error(privateText); } };
  for (const signature of ['', 'a', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(64)},other`]) {
    const response = await handleSentryWebhook(request({ signature }), guarded);
    assert.equal(response.status, 401);
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'OPTIONS']) {
    const response = await handleSentryWebhook(request({ method }), guarded);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  assert.equal(reads, 0);
});

test('query parameters and non-JSON/encoded bodies are rejected before accessing configuration', async () => {
  let reads = 0;
  const guarded = { getConfig() { reads++; return settings; } };
  for (const suffix of ['?project=other', '?']) {
    assert.equal((await handleSentryWebhook(request({ url: `https://example.invalid/api/webhooks/sentry${suffix}` }), guarded)).status, 400);
  }
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': '' }, { 'content-encoding': 'gzip' }]) {
    assert.equal((await handleSentryWebhook(request({ headers }), guarded)).status, 415);
  }
  assert.equal(reads, 0);
});

test('the 64 KiB limit applies to actual UTF-8 bytes and declared lengths', async () => {
  let reads = 0;
  const guarded = { getConfig() { reads++; return settings; } };
  for (const input of [
    request({ raw: 'x'.repeat(MAX_BODY_BYTES + 1) }),
    request({ raw: 'é'.repeat(MAX_BODY_BYTES / 2 + 1), headers: { 'content-length': '1' } }),
    request({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
  ]) assert.equal((await handleSentryWebhook(input, guarded)).status, 413);
  assert.equal(reads, 0);
});

test('a chunked stream is stopped once its actual bytes exceed the limit', async () => {
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  const input = new Request('https://example.invalid/api/webhooks/sentry', { method: 'POST', duplex: 'half', body: stream,
    headers: { 'content-type': 'application/json', 'sentry-hook-signature': 'a'.repeat(64) } });
  const response = await handleSentryWebhook(input, { getConfig() { reads++; return settings; } });
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(reads, 0);
});

test('unconfigured receiver and config/logging failures fail closed without leaking exception text', async () => {
  for (const config of [{}, { webhookSecret }, { ...settings, projectId: 'https://example.invalid/123' }, { ...settings, projectId: '0123' }]) {
    const response = await handleSentryWebhook(request(), { getConfig: () => config });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'sentry_receiver_unavailable' });
  }
  for (const patch of [
    { getConfig() { throw Error(privateText); } },
    { onVerified() { throw Error(privateText); } },
  ]) {
    const response = await handleSentryWebhook(request(), { ...options(), ...patch });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'sentry_delivery_unconfirmed' });
  }
});

test('correctly signed malformed JSON is rejected', async () => {
  const response = await handleSentryWebhook(request({ raw: '{invalid-json' }), options());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_sentry_json' });
});

test('signed unrelated resources, actions, projects, tags and invalid bindings are ignored', async () => {
  let calls = 0;
  const inputs = [
    request({ resource: 'issue' }), request({ payload: { ...event(), action: 'resolved' } }),
    request({ payload: null }), request({ payload: [] }), request({ payload: event({ project: '999' }) }),
    request({ payload: event({ tags: [['errand_demo', 'other']] }) }), request({ payload: event({ tags: null }) }),
    ...['', 'a'.repeat(39), 'g'.repeat(40), [release], null].map((value) => request({ payload: event({ release: value }) })),
    ...['0', '-1', '1e4', 'x', ['321'], 1e20, null].map((value) => request({ payload: event({ issue_id: value }) })),
  ];
  for (const input of inputs) {
    const response = await handleSentryWebhook(input, options(() => { calls++; }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'ignored' });
  }
  assert.equal(calls, 0);
});

test('object tags/numeric IDs are supported; repeat receipts are stable, issue/release changes differ', async () => {
  const receiptIds = [];
  const payloads = [event(), event(), event({ project: 123, issue_id: 321, tags: { errand_demo: 'upload_lf_v1' } }),
    event({ issue_id: '322' }), event({ release: 'b'.repeat(40) })];
  for (const payload of payloads) {
    const response = await handleSentryWebhook(request({ payload }), options());
    assert.equal(response.status, 200);
    receiptIds.push((await response.json()).receiptId);
  }
  assert.equal(receiptIds[0], receiptIds[1]);
  assert.equal(receiptIds[0], receiptIds[2]);
  assert.equal(new Set(receiptIds).size, 3);
});

test('the deployed Web Request entry point rejects probes before reading deployment settings', async () => {
  const response = await deployedHandler.fetch(request({ method: 'GET' }));
  assert.equal(response.status, 405);
  assert.equal((await deployedHandler.fetch(request({ signature: '' }))).status, 401);
});

test('the real local HTTP adapter handles a signed upload alert and preserves static routes', async (t) => {
  const receipts = [];
  const app = createApp({ sentryOptions: options((receipt) => { receipts.push(receipt); }) });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const raw = JSON.stringify(event(), null, 2);
  const response = await fetch(`${base}/api/webhooks/sentry`, { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json; charset=utf-8', 'sentry-hook-resource': 'event_alert',
      'sentry-hook-signature': sign(raw) } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).processing, 'not_connected');
  assert.equal(receipts.length, 1);
  assert.equal((await fetch(`${base}/api/webhooks/sentry`)).status, 405);
  assert.equal((await fetch(`${base}/api/webhooks/sentry`, { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  const home = await fetch(base);
  assert.equal(await home.text(), readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok', stage: 'web-foundation', servicesConnected: false });
});

test('signed delivery passes normalized evidence to durable intake and returns only the bound outcome', async () => {
  for (const status of ['queued', 'duplicate', 'unarmed']) {
    let bound;
    const result = await handleSentryWebhook(request(), options((receipt, normalized) => {
      bound = normalized;
      return { status, receiptId: normalized.eventId };
    }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).processing, status);
    assert.equal(bound.details.baseSha, release);
    assert.deepEqual(Object.keys(bound).sort(), ['details', 'eventId', 'project', 'title']);
  }
  const wrong = await handleSentryWebhook(request(), options(() => ({ status: 'queued', receiptId: 'f'.repeat(32) })));
  assert.equal(wrong.status, 503);
});
