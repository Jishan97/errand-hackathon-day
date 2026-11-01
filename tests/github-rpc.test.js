import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerRpcClient } from '../src/storage/github-rpc.js';

const secretKey = 'sb_secret_fixture_connection_read_only';
const supabaseUrl = 'https://abcdefghijklmnopqrst.supabase.co';

test('existing GitHub connection transport permits only the fixed read RPC and server header', async () => {
  const requests = [];
  const rpc = createServerRpcClient({ secretKey, supabaseUrl, fetcher: async (url, init) => {
    requests.push({ url, init }); return Response.json(null);
  } });
  await assert.rejects(rpc('errand_github_connection_save', {}), /unknown_storage_operation/);
  assert.equal(requests.length, 0);
  assert.equal(await rpc('errand_github_connection_get', { p_owner: 'fixture-owner' }), null);
  assert.equal(requests[0].url, supabaseUrl + '/rest/v1/rpc/errand_github_connection_get');
  assert.equal(requests[0].init.headers.apikey, secretKey);
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[0].init.redirect, 'error');
});

test('connection transport bounds responses and redacts provider or transport failures', async () => {
  for (const fetcher of [
    async () => new Response('x'.repeat(65537)),
    async () => new Response('private provider body', { status: 403 }),
    async () => { throw Error('private transport detail'); },
  ]) {
    const rpc = createServerRpcClient({ secretKey, supabaseUrl, fetcher });
    await assert.rejects(rpc('errand_github_connection_get', {}), (error) => {
      assert.ok(['storage_response_too_large', 'storage_request_rejected', 'storage_request_failed'].includes(error.code));
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  }
});
