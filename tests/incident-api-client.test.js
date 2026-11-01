import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncidentApiClient } from '../src/agents/api-client.js';

test('coding transport sends only explicit credentials to the fixed Agents endpoint without redirects', async () => {
  const requests = [];
  const client = createIncidentApiClient({ apiKey: 'fixture-key-only', requestTimeoutMs: 1000,
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ id: 'session_fixture', object: 'agent.session' });
    },
  });
  await client.beta.agents.sessions.retrieve('session_fixture');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/agents/sessions/session_fixture');
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get('authorization'), 'Bearer fixture-key-only');
  assert.equal(headers.get('openai-beta'), 'agents=v1');
  assert.equal(headers.get('openai-organization'), null);
  assert.equal(headers.get('openai-project'), null);
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization', 'content-type', 'openai-beta']);
});

test('coding client refuses unrelated SDK endpoints before network access', async () => {
  let calls = 0;
  const client = createIncidentApiClient({ apiKey: 'fixture-key-only', requestTimeoutMs: 1000,
    fetcher: async () => { calls++; return Response.json({ data: [] }); },
  });
  await assert.rejects(client.models.list());
  assert.equal(calls, 0);
});

test('coding transport caps declared and streamed response bytes with no automatic retry', async () => {
  for (const declared of [true, false]) {
    let calls = 0;
    const client = createIncidentApiClient({ apiKey: 'fixture-key-only', requestTimeoutMs: 1000,
      fetcher: async () => {
        calls++;
        return new Response('x'.repeat(256 * 1024 + 1), { headers: declared ? { 'content-length': String(256 * 1024 + 1) } : {} });
      },
    });
    await assert.rejects(client.beta.agents.sessions.retrieve('session_fixture'));
    assert.equal(calls, 1);
  }
});
