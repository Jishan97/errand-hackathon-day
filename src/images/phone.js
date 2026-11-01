import { createHash, randomUUID } from 'node:crypto';
import { generateImage, ImageFailure, boundedBytes } from './generate.js';

const uuid = /^[a-f0-9-]{36}$/i;
const callHash = callSid => {
  if (typeof callSid !== 'string' || !/^CA[a-f0-9]{32}$/i.test(callSid)) throw Error('invalid_image_call');
  return createHash('sha256').update(callSid).digest('hex');
};
export function createImageStore({ url, secret, fetcher = fetch }) {
  let origin;
  try { origin = new URL(url); } catch { throw Error('image_storage_unconfigured'); }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.supabase.co') || origin.origin !== url
    || typeof secret !== 'string' || !secret) throw Error('image_storage_unconfigured');
  async function request(query, method = 'GET', body) {
    try {
      const response = await fetcher(`${url}/rest/v1/errand_image_runs?${new URLSearchParams(query)}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { apikey: secret, ...(secret.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secret}` }),
          'Content-Type': 'application/json', Prefer: 'return=representation' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      const rows = JSON.parse((await boundedBytes(response.body, 5 * 1024 * 1024)).toString('utf8'));
      if (!Array.isArray(rows)) throw Error();
      return rows;
    } catch { throw Error('image_storage_unavailable'); }
  }
  const metadata = 'id,nonce,hash,summary,prompt,status,created_at,error_code';
  return {
    async stage(record) {
      const rows = await request({ select: metadata }, 'POST', record);
      if (rows.length !== 1 || rows[0].id !== record.id) throw Error('image_storage_unavailable');
      return rows[0];
    },
    async claim(callSid, proposal) {
      if (!uuid.test(proposal.id) || !uuid.test(proposal.nonce) || !/^[a-f0-9]{64}$/.test(proposal.hash)) throw Error('invalid_image_proposal');
      const rows = await request({ id: `eq.${proposal.id}`, call_hash: `eq.${callHash(callSid)}`,
        nonce: `eq.${proposal.nonce}`, hash: `eq.${proposal.hash}`, status: 'eq.proposed',
        created_at: `gte.${new Date(Date.now() - 600000).toISOString()}`, select: metadata }, 'PATCH', { status: 'running', started_at: new Date().toISOString() });
      if (rows.length !== 1) throw Error('image_proposal_already_claimed_or_expired');
      if (rows[0].id !== proposal.id || rows[0].nonce !== proposal.nonce || rows[0].hash !== proposal.hash
        || rows[0].status !== 'running' || typeof rows[0].prompt !== 'string' || !rows[0].prompt || rows[0].prompt.length > 160) throw Error('invalid_image_claim');
      return rows[0];
    },
    async finish(id, result) {
      const rows = await request({ id: `eq.${id}`, status: 'eq.running', select: 'id' }, 'PATCH', result);
      if (rows.length !== 1) throw Error('image_storage_unavailable');
    },
    async decline(callSid, id) {
      if (!uuid.test(id)) throw Error('invalid_image_proposal');
      await request({ id: `eq.${id}`, call_hash: `eq.${callHash(callSid)}`, status: 'eq.proposed', select: 'id' }, 'PATCH', { status: 'declined' });
    },
    async latest() {
      const rows = await request({ status: 'in.(running,ready,failed,uncertain)', order: 'started_at.desc', limit: '1', select: 'id,prompt,status,created_at,started_at,error_code' });
      const row = rows[0];
      // An interrupted worker never restarts a claimed generation automatically.
      if (row?.status === 'running' && Date.parse(row.started_at ?? row.created_at) < Date.now() - 300000) row.status = 'uncertain';
      return row ?? null;
    },
    async image(id) {
      if (!uuid.test(id)) throw Error('invalid_image_id');
      return (await request({ id: `eq.${id}`, status: 'eq.ready', select: 'image_base64', limit: '1' }))[0]?.image_base64 ?? null;
    },
  };
}

// Only called after the shared voice core's admission and spoken-confirmation gate.
export function createPhoneImages({ store, apiKey, model, schedule, generate = generateImage }) {
  return {
    enabled: true,
    async stage({ callSid, args, summary, hash, nonce }) {
      const row = await store.stage({ id: randomUUID(), call_hash: callHash(callSid), nonce, hash,
        summary, prompt: args.title, status: 'proposed' });
      return { id: row.id, nonce: row.nonce, hash: row.hash, summary: row.summary };
    },
    async confirm({ callSid, proposal }) {
      const job = await store.claim(callSid, proposal); // Atomic transition; consumed even on timeout.
      const boundHash = createHash('sha256').update(JSON.stringify({ operation: 'generate_image', args: { title: job.prompt }, summary: job.summary })).digest('hex');
      if (job.hash !== proposal.hash || boundHash !== proposal.hash) throw Error('image_proposal_changed');
      const work = (async () => {
        try {
          const image = await generate({ prompt: job.prompt, apiKey, model });
          await store.finish(job.id, { status: 'ready', image_base64: image.bytes.toString('base64') });
        } catch (error) {
          const definite = error instanceof ImageFailure && ['image_request_blocked', 'image_access_required', 'invalid_prompt', 'image_setup_required'].includes(error.code);
          try { await store.finish(job.id, { status: definite ? 'failed' : 'uncertain', error_code: 'image_not_completed' }); } catch { /* stays claimed; operator checks before retry */ }
        }
      })();
      try { schedule(work); } catch { /* work continues in the long-lived local phone process */ }
      return { status: 'confirmed', taskId: job.id, taskStatus: 'running' };
    },
    decline: (callSid, id) => store.decline(callSid, id),
  };
}
