import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGitHubAppClient } from '../src/github/app-client.js';
import { createIncidentInstallationCredential } from '../src/github/incident-credential.js';

const repository = 'Jishan97/errand-agent-demo';
const config = { incidentDemoEnabled: true, githubAppEnabled: true, values: {
  GITHUB_DEMO_REPO: repository, GITHUB_APP_ID: '123', GITHUB_APP_CLIENT_ID: 'fixture-client',
  GITHUB_APP_CLIENT_SECRET: 'fixture-client-secret', GITHUB_APP_SLUG: 'fixture-app',
  GITHUB_APP_SESSION_SECRET: 's'.repeat(40), PUBLIC_BASE_URL: 'https://example.test',
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
} };
const installation = { id: '789', appId: '123', suspended: false,
  account: { type: 'User', login: 'Jishan97', id: '456' },
  permissions: { contents: 'write', pull_requests: 'write', actions: 'read', checks: 'read' } };

test('direct incident access is restricted to the enabled fixed-repository demo', () => {
  for (const changes of [{ incidentDemoEnabled: false }, { githubAppEnabled: false },
    { values: { ...config.values, GITHUB_DEMO_REPO: 'Jishan97/other' } }]) {
    assert.throws(() => createIncidentInstallationCredential({ config: { ...config, ...changes }, client: {} }), /incident_repository_required/);
  }
});

test('direct access rejects wrong App, owner, organization, suspension and missing permissions before minting', async () => {
  for (const changes of [{ appId: '999' }, { suspended: true },
    { account: { type: 'Organization', login: 'Jishan97' } },
    { account: { type: 'User', login: 'someone-else' } },
    ...Object.keys(installation.permissions).map(key => ({ permissions: { ...installation.permissions, [key]: 'none' } }))]) {
    const credential = createIncidentInstallationCredential({ config, client: {
      async getRepositoryInstallation(repo) { assert.equal(repo, repository); return { ...installation, ...changes }; },
      async createInstallationToken() { assert.fail('Rejected installation cannot mint a token'); },
    } });
    await assert.rejects(credential.getToken(), /github_(personal_installation_required|app_permissions_required)/);
  }
});

test('App-authenticated discovery mints only a scoped incident token without OAuth or a saved connection', async () => {
  const raw = { id: 789, app_id: 123, account: installation.account,
    permissions: installation.permissions, repository_selection: 'selected', suspended_at: null };
  const calls = [];
  const client = createGitHubAppClient({ config, clock: () => 1000000, fetcher: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization.split('.').length, 3, 'App JWT is used');
    return Response.json(url.endsWith('/access_tokens') ? {
      token: 'fixture-scoped-token', expires_at: new Date(1000000 + 3600000).toISOString(),
      permissions: installation.permissions, repositories: [{ full_name: repository }],
    } : raw);
  } });
  const credential = createIncidentInstallationCredential({ config, client });
  assert.equal(await credential.getToken(), 'fixture-scoped-token');
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    `/repos/${repository}/installation`, '/app/installations/789', '/app/installations/789/access_tokens',
  ]);
  assert.deepEqual(JSON.parse(calls[2].init.body), { repositories: ['errand-agent-demo'], permissions: {
    contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read',
  } });
  await assert.rejects(client.getRepositoryInstallation('Jishan97/other'), /github_app_repository_not_allowed/);
  assert.equal(calls.length, 3);
});

test('discovery reports fixed missing-installation/authentication errors and rejects mismatched App metadata', async () => {
  for (const [status, code] of [[404, 'github_app_not_installed'], [401, 'github_app_authentication_failed']]) {
    const client = createGitHubAppClient({ config, fetcher: async () => new Response('private-provider-message', { status }) });
    await assert.rejects(client.getRepositoryInstallation(repository), error => error.message === code);
  }
  const client = createGitHubAppClient({ config, fetcher: async () => Response.json({ id: 789, app_id: 999,
    account: installation.account, permissions: installation.permissions, repository_selection: 'selected', suspended_at: null }) });
  await assert.rejects(client.getRepositoryInstallation(repository), /github_app_installation_mismatch/);
});
