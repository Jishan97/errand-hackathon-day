import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncidentRuntime } from '../src/core/runtime.js';
import { handleOperator } from '../src/core/operator.js';

const fixture = {
  ENABLE_FAST_INCIDENT_DEMO: 'true', ENABLE_GITHUB_APP: 'true', ENABLE_LIVE_VOICE: 'true',
  GITHUB_APP_ID: '123', GITHUB_APP_CLIENT_ID: 'fixture-client',
  GITHUB_APP_CLIENT_SECRET: 'fixture-client-secret', GITHUB_APP_PRIVATE_KEY_BASE64: 'Zml4dHVyZQ==',
  GITHUB_APP_SLUG: 'fixture-app', GITHUB_APP_SESSION_SECRET: 'x'.repeat(40),
  PUBLIC_BASE_URL: 'https://example.test', GITHUB_DEMO_REPO: 'Jishan97/errand-agent-demo',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'b'.repeat(32),
  TWILIO_FROM_NUMBER: '+12025550101', TEST_RESIDENT_NUMBER: '+12025550102',
  OPENAI_AGENT_MODEL: 'gpt-6.1-sol', OPENAI_API_KEY: 'fixture-api-key',
};

test('runtime setup failures identify only the component and keep provider values private', async () => {
  const token = 'fixture_operator_'.padEnd(40, 'x');
  for (const [field, value, code] of [
    ['ENABLE_GITHUB_APP', 'false', 'incident_github_disabled'],
    ['GITHUB_APP_CLIENT_SECRET', '', 'incident_github_unconfigured'],
    ['ENABLE_LIVE_VOICE', 'false', 'incident_callback_disabled'],
    ['TWILIO_AUTH_TOKEN', 'private-invalid-provider-value', 'incident_callback_unconfigured'],
    ['OPENAI_AGENT_MODEL', 'other-model', 'incident_model_unconfigured'],
    ['OPENAI_API_KEY', '', 'incident_openai_unconfigured'],
  ]) {
    const request = new Request('https://example.test/api/incident/prepare?action=prepare', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const result = await handleOperator(request, {
      getToken: () => token,
      getRuntime: () => createIncidentRuntime({ ...fixture, [field]: value }),
      schedule: () => assert.fail('Preflight cannot schedule a repair'),
    });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: code, ...(code === 'incident_github_unconfigured' ? { setting: field } : {}) });
  }
});

test('GitHub setup diagnostics expose only an approved setting name, never its invalid value', async () => {
  for (const field of ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_SLUG', 'GITHUB_APP_SESSION_SECRET', 'PUBLIC_BASE_URL', 'GITHUB_DEMO_REPO']) {
    assert.throws(() => createIncidentRuntime({ ...fixture, [field]: '' }), error =>
      error.message === 'incident_github_unconfigured' && error.setting === field);
  }
});
