import { createHash, timingSafeEqual } from 'node:crypto';
import { REPAIR_SCOPE } from './fast-worker.js';

const sha = /^[a-f0-9]{40}$/;
const receipt = /^[a-f0-9]{32}$/;
const githubSettings = new Set(['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_SLUG', 'GITHUB_APP_SESSION_SECRET', 'PUBLIC_BASE_URL', 'GITHUB_DEMO_REPO']);
const hash = (v) => createHash('sha256').update(v).digest();
const response = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const safeErrors = new Set(['incident_disabled', 'incident_unconfigured', 'fast_storage_unconfigured',
  'incident_github_disabled', 'incident_github_unconfigured', 'incident_callback_disabled',
  'incident_callback_unconfigured', 'incident_model_unconfigured', 'incident_openai_unconfigured',
  'fast_storage_request_unconfirmed', 'github_app_permissions_required', 'github_app_not_connected',
  'github_connection_unverified', 'github_app_not_installed', 'github_app_authentication_failed',
  'github_app_private_key_invalid', 'github_personal_installation_required',
  'incident_base_changed', 'incident_ci_definition_changed']);

export async function handleOperator(request, { getToken, getRuntime, schedule }) {
  const url = new URL(request.url);
  const action = url.pathname.split('/').at(-1);
  if (!['prepare', 'arm', 'status', 'resume'].includes(action)) return response(404, { error: 'not_found' });
  if (request.method !== (action === 'status' ? 'GET' : 'POST')) return response(405, { error: 'method_not_allowed' });
  const supplied = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  if (!supplied) return response(401, { error: 'operator_required' });
  const expected = getToken();
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(expected) || !timingSafeEqual(hash(expected), hash(supplied))) {
    return response(403, { error: 'operator_rejected' });
  }
  // Vercel's [action] route adds its matched segment to the query string.
  // Accept only one exact copy; it must never select a different operation.
  const routeActions = url.searchParams.getAll('action');
  if (routeActions.length) {
    if (routeActions.length !== 1 || routeActions[0] !== action) return response(400, { error: 'invalid_request' });
    url.searchParams.delete('action');
  }
  if ((action === 'status' && url.search && (url.searchParams.size !== 1 || !receipt.test(url.searchParams.get('id') ?? ''))) ||
      (action !== 'status' && url.search)) return response(400, { error: 'invalid_request' });
  let body = {};
  if (action !== 'status') {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return response(415, { error: 'json_required' });
    if (Number(request.headers.get('content-length') ?? 0) > 2048) return response(413, { error: 'body_too_large' });
    // Bound actual bytes too, including streamed bodies without Content-Length.
    const reader = request.body?.getReader();
    let length = 0;
    const chunks = [];
    if (reader) {
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 2048) { await reader.cancel(); return response(413, { error: 'body_too_large' }); }
          chunks.push(value);
        }
      } catch {
        return response(400, { error: 'invalid_body' });
      } finally { reader.releaseLock(); }
    }
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return response(400, { error: 'invalid_json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response(400, { error: 'invalid_request' });
  }
  try {
    const runtime = getRuntime();
    if (action === 'status') return response(200, await runtime.store.status(url.searchParams.get('id')));
    if (action === 'prepare') {
      if (Object.keys(body).length) return response(400, { error: 'invalid_request' });
      const baseSha = await runtime.github.currentHead();
      await runtime.github.snapshot(baseSha);
      return response(200, { baseSha, scope: REPAIR_SCOPE, repository: 'Jishan97/errand-agent-demo' });
    }
    if (action === 'arm') {
      if (Object.keys(body).sort().join() !== 'baseSha,scope' || !sha.test(body.baseSha ?? '') || body.scope !== REPAIR_SCOPE) {
        return response(400, { error: 'invalid_approval' });
      }
      await runtime.github.snapshot(body.baseSha);
      return response(200, await runtime.store.arm(body.baseSha, body.scope));
    }
    if (Object.keys(body).join() !== 'receiptId' || !receipt.test(body.receiptId ?? '')) return response(400, { error: 'invalid_request' });
    schedule(runtime, body.receiptId);
    return response(202, { status: 'resume_requested', receiptId: body.receiptId });
  } catch (error) {
    const code = safeErrors.has(error?.message) ? error.message : 'incident_operation_unavailable';
    return response(503, { error: code, ...(code === 'incident_github_unconfigured' && githubSettings.has(error.setting)
      ? { setting: error.setting } : {}) });
  }
}
