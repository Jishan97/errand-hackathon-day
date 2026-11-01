import test from 'node:test';
import assert from 'node:assert/strict';
import { completionCallIsConfigured, createCompletionCaller } from '../src/voice/completion-call.js';

// Synthetic provider credentials and reserved fictional phone numbers only.
const config = {
  liveVoiceEnabled: true,
  values: {
    TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'b'.repeat(32),
    TWILIO_FROM_NUMBER: '+12025550101',
    TEST_RESIDENT_NUMBER: '+12025550102',
  },
};
const evidence = {
  testsPassed: true, ciPassed: true, deploymentVerified: true, replayVerified: true,
  mergeCommit: 'c'.repeat(40), deployedCommit: 'c'.repeat(40),
};
const providerResult = {
  sid: `CA${'d'.repeat(32)}`, account_sid: config.values.TWILIO_ACCOUNT_SID,
  from: config.values.TWILIO_FROM_NUMBER, to: config.values.TEST_RESIDENT_NUMBER,
  direction: 'outbound-api', status: 'queued',
};
const accepted = () => Response.json(providerResult, { status: 201 });

test('verified repair submits fixed completion TwiML only to the configured recipient', async () => {
  let calls = 0;
  const caller = createCompletionCaller({ config, fetcher: async (url, options) => {
    calls += 1;
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${config.values.TWILIO_ACCOUNT_SID}/Calls.json`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization,
      `Basic ${Buffer.from(`${config.values.TWILIO_ACCOUNT_SID}:${config.values.TWILIO_AUTH_TOKEN}`).toString('base64')}`);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('From'), config.values.TWILIO_FROM_NUMBER);
    assert.equal(form.get('To'), config.values.TEST_RESIDENT_NUMBER);
    assert.equal(form.get('Url'), null);
    assert.equal(form.get('Record'), 'false');
    assert.equal(form.get('Timeout'), '20');
    assert.equal(form.get('TimeLimit'), '45');
    assert.match(form.get('Twiml'), /Errand, an AI assistant/);
    assert.match(form.get('Twiml'), /verified the upload on the live deployment/);
    assert.doesNotMatch(form.get('Twiml'), /attacker|Sentry issue is resolved/);
    return accepted();
  } });
  const result = await caller.call({ ...evidence, to: '+12025550199', message: 'attacker' });
  assert.deepEqual(result, { status: 'submitted_not_verified' });
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /CA|AC|1202555/);
});

test('every verification gate is required before any call can be submitted', async () => {
  let calls = 0;
  const caller = createCompletionCaller({ config, fetcher: async () => { calls += 1; return accepted(); } });
  const invalid = [null, {}, ...['testsPassed', 'ciPassed', 'deploymentVerified', 'replayVerified'].flatMap((key) => [
    { ...evidence, [key]: false }, { ...evidence, [key]: 'true' }, { ...evidence, [key]: undefined },
  ]), { ...evidence, deployedCommit: 'e'.repeat(40) }, { ...evidence, mergeCommit: 'invalid', deployedCommit: 'invalid' }];
  for (const value of invalid) await assert.rejects(caller.call(value), { code: 'callback_evidence_required' });
  assert.equal(calls, 0);
});

test('disabled or malformed private configuration stops before the transport', async () => {
  let calls = 0;
  const invalid = [undefined, {}, { ...config, liveVoiceEnabled: false }, { ...config, liveVoiceEnabled: 'true' },
    ...[
      ['TWILIO_ACCOUNT_SID', 'https://attacker.invalid'], ['TWILIO_AUTH_TOKEN', 'bad\nvalue'],
      ['TWILIO_FROM_NUMBER', 'not-a-number'], ['TEST_RESIDENT_NUMBER', '+12025550102?forward=evil'],
    ].map(([key, value]) => ({ ...config, values: { ...config.values, [key]: value } }))];
  assert.equal(completionCallIsConfigured(config), true);
  for (const value of invalid) {
    assert.equal(completionCallIsConfigured(value), false);
    const caller = createCompletionCaller({ config: value, fetcher: async () => { calls += 1; return accepted(); } });
    await assert.rejects(caller.call(evidence), { code: 'callback_disabled_or_unconfigured' });
  }
  assert.equal(calls, 0);
});

test('submission errors are redacted and never retried', async () => {
  const transports = [
    async () => { throw Error('private provider response'); },
    async () => Response.json({ message: 'private provider response' }, { status: 401 }),
    async () => Response.json({ message: 'private provider response' }, { status: 500 }),
    async () => new Response('invalid private JSON', { status: 201 }),
    async () => Response.json({ ...providerResult, sid: 'invalid' }, { status: 201 }),
    async () => Response.json({ ...providerResult, account_sid: `AC${'e'.repeat(32)}` }, { status: 201 }),
    async () => Response.json({ ...providerResult, to: '+12025550199' }, { status: 201 }),
    async () => Response.json({ ...providerResult, direction: 'inbound' }, { status: 201 }),
    async () => Response.json({ ...providerResult, status: 'failed' }, { status: 201 }),
  ];
  for (const transport of transports) {
    let calls = 0;
    const caller = createCompletionCaller({ config, fetcher: async (...args) => { calls += 1; return transport(...args); } });
    await assert.rejects(caller.call(evidence), (error) => {
      assert.equal(error.code, 'callback_submission_unconfirmed');
      assert.equal(error.message, 'callback_submission_unconfirmed');
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('declared and actual response limits reject oversized bodies without leaking content', async () => {
  const responses = [
    () => new Response('private', { status: 201, headers: { 'content-length': '8193' } }),
    () => new Response('x'.repeat(8193), { status: 201 }),
    () => new Response('private', { status: 201, headers: { 'content-length': 'invalid' } }),
  ];
  for (const response of responses) {
    const caller = createCompletionCaller({ config, fetcher: async () => response() });
    await assert.rejects(caller.call(evidence), { code: 'callback_submission_unconfirmed' });
  }
});
