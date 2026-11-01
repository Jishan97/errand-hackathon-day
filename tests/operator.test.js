import test from 'node:test';
import assert from 'node:assert/strict';
import { handleOperator } from '../src/core/operator.js';
import { REPAIR_SCOPE } from '../src/core/fast-worker.js';

const token = 'synthetic_operator_'.padEnd(40, 'x');
const baseSha = 'b'.repeat(40);
const receiptId = 'a'.repeat(32);
function request(action, { body, auth = token, method = action.startsWith('status') ? 'GET' : 'POST', headers = {} } = {}) {
  return new Request(`https://example.test/api/incident/${action}`, { method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(method === 'POST' ? { body: body === undefined ? '{}' : typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
function fixture() {
  const calls = [];
  const runtime = {
    github: { async currentHead() { calls.push('head'); return baseSha; },
      async snapshot(sha) { calls.push(['snapshot', sha]); return { baseSha: sha, files: [] }; } },
    store: { async arm(sha, scope) { calls.push(['arm', sha, scope]); return { status: 'approved', baseSha: sha, scope }; },
      async status(id) { calls.push(['status', id]); return { status: 'running', receiptId: id, phase: 'repair_poll' }; } },
  };
  return { calls, runtime, options: {
    getToken() { calls.push('token'); return token; },
    getRuntime() { calls.push('runtime'); return runtime; },
    schedule(value, id) { assert.equal(value, runtime); calls.push(['schedule', id]); },
  } };
}

test('missing or invalid authorization never constructs the runtime', async () => {
  for (const auth of [null, 'bad', 'z'.repeat(40)]) {
    const f = fixture();
    const result = await handleOperator(request('prepare', { auth }), f.options);
    assert.equal(result.status, auth?.length === 40 ? 403 : 401);
    assert.equal(f.calls.includes('runtime'), false);
    if (result.status === 401) assert.deepEqual(f.calls, []);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
});

test('prepare checks the exact current snapshot and only returns safe approval scope', async () => {
  const f = fixture();
  const result = await handleOperator(request('prepare'), f.options);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { baseSha, scope: REPAIR_SCOPE, repository: 'Jishan97/errand-agent-demo' });
  assert.deepEqual(f.calls, ['token', 'runtime', 'head', ['snapshot', baseSha]]);
});

test('arming accepts only exact scope and revision and rechecks current source first', async () => {
  const f = fixture();
  const result = await handleOperator(request('arm', { body: { baseSha, scope: REPAIR_SCOPE } }), f.options);
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls, ['token', 'runtime', ['snapshot', baseSha], ['arm', baseSha, REPAIR_SCOPE]]);
  for (const body of [{}, { baseSha }, { baseSha: 'bad', scope: REPAIR_SCOPE },
    { baseSha, scope: 'unbounded-fix' }, { baseSha, scope: REPAIR_SCOPE, recipient: 'someone' }]) {
    const invalid = fixture();
    assert.equal((await handleOperator(request('arm', { body }), invalid.options)).status, 400);
    assert.equal(invalid.calls.some((call) => Array.isArray(call) && call[0] === 'arm'), false);
  }
});

test('a stale or unavailable target does not save approval or reveal provider errors', async () => {
  const f = fixture();
  f.runtime.github.snapshot = async () => { throw Error('private provider response'); };
  const result = await handleOperator(request('arm', { body: { baseSha, scope: REPAIR_SCOPE } }), f.options);
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: 'incident_operation_unavailable' });
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'arm'), false);
});

test('status and resume bind one receipt and reject malformed or unexpected query data', async () => {
  const f = fixture();
  assert.equal((await handleOperator(request(`status?id=${receiptId}`), f.options)).status, 200);
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'status' && call[1] === receiptId));
  // Without an ID, the operator sees the latest run's sanitized projection.
  assert.equal((await handleOperator(request('status'), f.options)).status, 200);
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'status' && call[1] === null));
  assert.equal((await handleOperator(request('resume', { body: { receiptId } }), f.options)).status, 202);
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'schedule' && call[1] === receiptId));
  for (const action of ['status?id=bad', `status?id=${receiptId}&extra=1`, `status?id=${receiptId}&id=${receiptId}`, 'prepare?extra=1']) {
    const invalid = fixture();
    assert.equal((await handleOperator(request(action), invalid.options)).status, 400, action);
    assert.equal(invalid.calls.includes('runtime'), false, action);
  }
});

test('Vercel dynamic route metadata preserves each operation and rejects conflicting parameters', async () => {
  for (const [action, body, status] of [
    ['prepare?action=prepare', {}, 200],
    ['arm?action=arm', { baseSha, scope: REPAIR_SCOPE }, 200],
    ['status?action=status', undefined, 200],
    [`status?action=status&id=${receiptId}`, undefined, 200],
    ['resume?action=resume', { receiptId }, 202],
  ]) {
    const f = fixture();
    assert.equal((await handleOperator(request(action, { body }), f.options)).status, status, action);
    if (action.includes('id=')) assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'status' && call[1] === receiptId));
  }
  for (const action of ['prepare?action=arm', 'prepare?action=', 'prepare?action=prepare&action=prepare',
    'prepare?action=prepare&extra=1', 'status?action=status&id=bad',
    `status?action=status&id=${receiptId}&id=${receiptId}`]) {
    const f = fixture();
    assert.equal((await handleOperator(request(action), f.options)).status, 400, action);
    assert.equal(f.calls.includes('runtime'), false);
  }
});

test('request method, content type, JSON shape and both body limits are enforced', async () => {
  const cases = [
    [request('arm', { method: 'GET' }), 405],
    [request('unknown'), 404],
    [request('prepare', { headers: { 'Content-Type': 'text/plain' } }), 415],
    [request('prepare', { body: 'broken' }), 400],
    [request('prepare', { body: '[]' }), 400],
    [request('prepare', { body: 'null' }), 400],
    [request('prepare', { body: '{}', headers: { 'Content-Length': '2049' } }), 413],
    [request('prepare', { body: 'x'.repeat(2049) }), 413],
  ];
  for (const [input, status] of cases) {
    const f = fixture();
    const result = await handleOperator(input, f.options);
    assert.equal(result.status, status);
    assert.equal(f.calls.includes('runtime'), false);
  }
});

test('a failed request-body stream yields a sanitized response before runtime construction', async () => {
  const f = fixture();
  const body = new ReadableStream({ start(controller) { controller.error(Error('private transport failure')); } });
  const input = new Request('https://example.test/api/incident/prepare', { method: 'POST', duplex: 'half', body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const result = await handleOperator(input, f.options);
  assert.ok([400, 503].includes(result.status));
  assert.doesNotMatch(await result.text(), /private transport failure/);
  assert.equal(f.calls.includes('runtime'), false);
});
