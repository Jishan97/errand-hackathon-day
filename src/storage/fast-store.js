// Adapted from the prepared MVP's bounded server RPC and incident repository.
// Runtime configuration is injected; this module never reads process.env/files.
export const FAST_SCOPE = 'upload-parser-fix-test-pr-merge-replay-callback';
const receiptPattern = /^[a-f0-9]{32}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const phases = new Set(['repair_start', 'repair_poll', 'cleanup', 'create_pr', 'ci_wait', 'merge', 'deployment_wait', 'callback', 'completed', 'failed', 'unknown']);
const terminal = new Set(['completed', 'failed', 'unknown']);
const names = new Set(['errand_alert_arm', 'errand_alert_accept', 'errand_alert_claim', 'errand_alert_record', 'errand_alert_status', 'errand_fast_arm', 'errand_fast_accept', 'errand_fast_claim', 'errand_fast_advance', 'errand_fast_status']);
const forbidden = /token|secret|password|authorization|cookie|privatekey|credential/i;
const fail = (code = 'fast_storage_invalid') => { throw new Error(code); };
const string = (value, pattern) => { if (typeof value !== 'string' || !pattern.test(value)) fail(); return value; };
const date = (value) => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(); return value; };
const phase = (value) => { if (!phases.has(value)) fail(); return value; };

function safeObject(input, maxBytes) {
  function clone(value, depth = 0) {
    if (depth > 16) fail();
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value === 'string') { if (value.includes('\0')) fail(); return value; }
    if (!value || typeof value !== 'object') fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (value.length > 256) fail();
      return Array.from({ length: value.length }, (_, i) => {
        const entry = descriptors[i]; if (!entry || !('value' in entry)) fail(); return clone(entry.value, depth + 1);
      });
    }
    if (Object.keys(descriptors).length > 128) fail();
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(descriptors)) {
      if (!('value' in entry) || forbidden.test(key.replaceAll(/[^a-z]/gi, ''))) fail();
      result[key] = clone(entry.value, depth + 1);
    }
    return result;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const text = JSON.stringify(clone(input));
  if (Buffer.byteLength(text) > maxBytes) fail();
  return JSON.parse(text);
}

function event(input) {
  const value = safeObject(input, 4000);
  if (Object.keys(value).sort().join() !== 'details,eventId,project,title'
    || !value.details || Object.keys(value.details).sort().join() !== 'baseSha,fixture,issueId'
    || value.title !== 'Sample plant upload failed' || value.details.fixture !== 'upload_lf_v1') fail();
  string(value.eventId, receiptPattern); string(value.project, /^[1-9]\d{0,19}$/);
  string(value.details.issueId, /^[1-9]\d{0,19}$/); string(value.details.baseSha, shaPattern);
  return value;
}

function approval(value) {
  const result = safeObject(value, 2000);
  if (result.scope !== FAST_SCOPE) fail();
  return { id: string(result.id, uuidPattern), baseSha: string(result.baseSha, shaPattern), scope: FAST_SCOPE, expiresAt: date(result.expiresAt) };
}

export function createFastStore({ rpc }) {
  if (typeof rpc !== 'function') fail('fast_storage_unconfigured');
  async function request(name, input, validate) {
    let result;
    try { result = await rpc(name, input); } catch { fail('fast_storage_request_unconfirmed'); }
    try { return validate(safeObject(result, 192000)); } catch { fail('fast_storage_response_invalid'); }
  }
  return Object.freeze({
    arm(baseSha, scope = FAST_SCOPE) {
      string(baseSha, shaPattern); if (scope !== FAST_SCOPE) fail();
      return request('errand_fast_arm', { p_base_sha: baseSha, p_scope: scope }, (result) => {
        if (result.status !== 'approved') fail();
        const bound = approval(result); if (bound.baseSha !== baseSha) fail();
        return { status: 'approved', ...bound };
      });
    },
    accept(input) {
      const bound = event(input);
      return request('errand_fast_accept', { p_event: bound }, (result) => {
        if (!['queued', 'duplicate', 'unarmed'].includes(result.status) || result.receiptId !== bound.eventId) fail();
        return { status: result.status, receiptId: bound.eventId };
      });
    },
    claim(id) {
      string(id, receiptPattern);
      return request('errand_fast_claim', { p_id: id }, (result) => {
        if (['missing', 'busy'].includes(result.status)) return { status: result.status };
        if (result.status === 'terminal') { if (!terminal.has(result.phase)) fail(); return { status: 'terminal', phase: result.phase }; }
        if (result.status !== 'claimed' || result.id !== id) fail();
        const bound = event(result.event), approved = approval(result.approval);
        if (bound.eventId !== id || approved.baseSha !== bound.details.baseSha || terminal.has(result.phase)) fail();
        return { status: 'claimed', id, phase: phase(result.phase), state: safeObject(result.state, 160000), event: bound,
          approval: approved, lease: string(result.lease, uuidPattern), createdAt: date(result.createdAt) };
      });
    },
    advance(job, progress) {
      const id = string(job?.id, receiptPattern), lease = string(job?.lease, uuidPattern);
      const next = phase(progress?.phase), state = safeObject(progress?.state, 160000);
      return request('errand_fast_advance', { p_id: id, p_lease: lease, p_phase: next, p_state: state }, (result) => {
        if (result.status !== 'recorded' || result.receiptId !== id || result.phase !== next) fail();
        return { status: 'recorded', receiptId: id, phase: next };
      });
    },
    status(id = null) {
      if (id !== null) string(id, receiptPattern);
      return request('errand_fast_status', { p_id: id }, (result) => {
        if (result.status === 'missing') return { status: 'missing' };
        if (result.status !== 'found' || (id !== null && result.receiptId !== id) || !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0) fail();
        const safe = { status: 'found', receiptId: string(result.receiptId, receiptPattern), phase: phase(result.phase), createdAt: date(result.createdAt),
          updatedAt: date(result.updatedAt), elapsedMs: result.elapsedMs };
        for (const key of ['testsPassed', 'ciPassed', 'replayVerified']) { if (typeof result[key] !== 'boolean') fail(); safe[key] = result[key]; }
        if (result.pullRequest !== undefined) safe.pullRequest = string(result.pullRequest, /^https:\/\/github\.com\/Jishan97\/errand-agent-demo\/pull\/[1-9]\d*$/);
        if (result.mergeCommit !== undefined) safe.mergeCommit = string(result.mergeCommit, shaPattern);
        if (result.callbackStatus !== undefined) { if (!['submitted_not_verified', 'unknown'].includes(result.callbackStatus)) fail(); safe.callbackStatus = result.callbackStatus; }
        if (result.stoppedAtPhase !== undefined) safe.stoppedAtPhase = phase(result.stoppedAtPhase);
        if (result.cleanupVerified !== undefined) { if (typeof result.cleanupVerified !== 'boolean') fail(); safe.cleanupVerified = result.cleanupVerified; }
        return safe;
      });
    },
  });
}

export function createFastRpc({ url, secret, fetcher = globalThis.fetch, timeoutMs = 8000 }) {
  let origin;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname)
      || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) fail();
    origin = parsed.origin;
    if (typeof secret !== 'string' || !/^sb_secret_[A-Za-z0-9_-]{20,200}$/.test(secret)
      || typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) fail();
  } catch { fail('fast_storage_unconfigured'); }
  return async (name, parameters) => {
    if (!names.has(name)) fail('fast_storage_operation_invalid');
    const body = JSON.stringify(safeObject(parameters, 170000));
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(`${origin}/rest/v1/rpc/${name}`, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { apikey: secret, 'Content-Type': 'application/json', Accept: 'application/json' }, body });
          if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(); }
          const reader = response.body?.getReader(); if (!reader) fail();
          const chunks = []; let size = 0;
          try {
            while (true) {
              const part = await reader.read(); if (part.done) break;
              size += part.value.byteLength; if (size > 192000) fail(); chunks.push(part.value);
            }
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } finally { await reader.cancel().catch(() => {}); }
        })(),
        new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('fast_storage_timeout')); }, timeoutMs); }),
      ]);
    } catch { fail('fast_storage_request_unconfirmed'); }
    finally { clearTimeout(timer); controller.abort(); }
  };
}
