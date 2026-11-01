import { randomUUID } from 'node:crypto';
import { GmailError, requireValue, safeId } from '../integrations/gmail/composio.js';

const operations = new Set(['get_binding','put_attempt','get_attempt','finish_attempt','new_task','get_task','revise_task',
  'put_proposal','get_proposal','get_outcome','record_outcome','approve','claim','can_reconcile','finish_worker','cancel','get_asset','put_asset','pending','close_manual']);
const maxBytes = 20 * 1024 * 1024;

// Separate limits and RPC allowlist: main's small incident transport is unchanged.
export function createGmailRpc({ url, secret, fetcher = fetch, rpcName = 'errand_gmail' }) {
  requireValue(['errand_gmail', 'errand_gmail_image'].includes(rpcName));
  let origin;
  try {
    const parsed = new URL(url);
    requireValue(parsed.protocol === 'https:' && /^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname)
      && !parsed.username && !parsed.password && !parsed.port && parsed.pathname === '/' && !parsed.search && !parsed.hash);
    requireValue(typeof secret === 'string' && /^sb_secret_[A-Za-z0-9_-]{20,200}$/.test(secret));
    origin = parsed.origin;
  } catch { throw new GmailError('gmail_storage_unconfigured', 503); }
  return async (op, userId, args = {}) => {
    requireValue(operations.has(op), 'gmail_operation_invalid'); safeId(userId);
    const body = JSON.stringify({ p_op: op, p_user: userId, p_args: args });
    requireValue(Buffer.byteLength(body) <= maxBytes, 'gmail_storage_too_large');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetcher(`${origin}/rest/v1/rpc/${rpcName}`, { method: 'POST', redirect: 'error',
        headers: { apikey: secret, 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw Error('storage'); }
      const reader = response.body?.getReader(); requireValue(reader);
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > maxBytes) throw Error('size'); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return size ? JSON.parse(Buffer.concat(chunks, size).toString('utf8')) : null;
    } catch { throw new GmailError('gmail_storage_unavailable', 503); }
    finally { clearTimeout(timer); controller.abort(); }
  };
}

export function createGmailStore({ rpc, userId }) {
  safeId(userId); requireValue(typeof rpc === 'function');
  const owner = supplied => requireValue(supplied === userId, 'gmail_owner_mismatch', 403);
  const call = (op, args) => rpc(op, userId, args);
  async function taskCall(op, args) {
    const result = await call(op, args);
    if (result?.status === 'unresolved') {
      const error = new GmailError('gmail_unresolved', 409); error.proposalId = safeId(result.proposalId); throw error;
    }
    return result;
  }
  const store = {
    getBinding: async user => { owner(user); return call('get_binding'); },
    putAttempt: async value => { owner(value.userId); return call('put_attempt', { value }); },
    getAttempt: async (user, sessionId) => { owner(user); return call('get_attempt', { sessionId }); },
    finishAttempt: async (attempt, binding) => { owner(attempt.userId); owner(binding.userId); return call('finish_attempt', { attempt, binding }); },
    newTask: () => taskCall('new_task', { id: randomUUID() }),
    getTask: id => call('get_task', { id: safeId(id) }),
    reviseTask: id => taskCall('revise_task', { id: safeId(id) }),
    pending: () => call('pending'),
    closeManual: (id, digest, acknowledgement) => call('close_manual', { id: safeId(id), digest, acknowledgement }),
    putProposal: async value => { owner(value.userId); return call('put_proposal', { value }); },
    getProposal: id => call('get_proposal', { id: safeId(id) }),
    getOutcome: id => call('get_outcome', { id: safeId(id) }),
    recordOutcome: (id, value) => call('record_outcome', { id: safeId(id), value }),
    approve: async scope => { owner(scope.userId); return call('approve', { id: scope.proposalId, scope }); },
    finishWorker: id => call('finish_worker', { id: safeId(id) }),
    cancel: id => call('cancel', { id: safeId(id) }),
    resolveImageAsset: async (context, id) => {
      owner(context.userId);
      const value = await call('get_asset', { id: safeId(id), taskId: safeId(context.taskId) });
      if (!value) return null;
      const { data, ...metadata } = value;
      requireValue(typeof data === 'string' && data.length <= 6990508, 'invalid_image_size');
      return { ...metadata, bytes: Buffer.from(data, 'base64') };
    },
    // Internal generation-worker seam, not exposed by any HTTP route/model tool.
    putImageAsset: async asset => {
      owner(asset.userId); safeId(asset.assetId); safeId(asset.taskId);
      requireValue(asset.bytes instanceof Uint8Array && asset.bytes.byteLength <= 5 * 1024 * 1024, 'invalid_image_size');
      const { bytes, ...metadata } = asset;
      return call('put_asset', { value: { ...metadata, data: Buffer.from(bytes).toString('base64') } });
    },
  };
  const approvalGate = {
    claim: async scope => { owner(scope.userId); return call('claim', { id: scope.proposalId, scope }); },
    canReconcile: async (context, scope) => {
      owner(context.userId); owner(scope.userId);
      return call('can_reconcile', { id: scope.proposalId, scope });
    },
  };
  return { store: Object.freeze(store), approvalGate: Object.freeze(approvalGate) };
}
