import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Adapted from Errand's pre-event mvp/src/assistant/sentry.js and raw HTTP intake.
// No storage, provider calls or work execution are connected in this slice.
export const MAX_BODY_BYTES = 64 * 1024;

class DeliveryError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function reply(status, body, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });
}

async function readBody(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new DeliveryError(413, 'sentry_body_too_large');
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new DeliveryError(413, 'sentry_body_too_large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

function numericId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null;
}

export function parseSentryAlert({ body, signature, resource, webhookSecret, projectId }) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BODY_BYTES || typeof signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(signature)) throw new DeliveryError(403, 'invalid_sentry_signature');
  const expected = createHmac('sha256', webhookSecret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    throw new DeliveryError(403, 'invalid_sentry_signature');
  }
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { throw new DeliveryError(400, 'invalid_sentry_json'); }
  if (resource !== 'event_alert' || payload?.action !== 'triggered') return null;

  const event = payload?.data?.event;
  const tags = Array.isArray(event?.tags)
    ? Object.fromEntries(event.tags.filter((tag) => Array.isArray(tag) && tag.length === 2 &&
      typeof tag[0] === 'string' && typeof tag[1] === 'string'))
    : event?.tags;
  const issueId = numericId(event?.issue_id);
  if (numericId(event?.project) !== projectId || tags?.errand_demo !== 'upload_lf_v1' ||
      typeof event?.release !== 'string' || !/^[a-f0-9]{40}$/.test(event.release) || !issueId) return null;

  const eventId = createHash('sha256').update(`${projectId}:${issueId}:${event.release}`).digest('hex').slice(0, 32);
  // Allowlist only the bounded incident fields used by the prepared MVP.
  return Object.freeze({ eventId, project: projectId, title: 'Sample plant upload failed',
    details: Object.freeze({ issueId, baseSha: event.release, fixture: 'upload_lf_v1' }) });
}

export async function handleSentryWebhook(request, { getConfig = () => ({}), onVerified = () => {} } = {}) {
  if (request.method !== 'POST') return reply(405, { error: 'post_required' }, { Allow: 'POST' });
  if (new URL(request.url).href.includes('?')) return reply(400, { error: 'query_not_allowed' });
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
      ![null, 'identity'].includes(request.headers.get('content-encoding'))) {
    return reply(415, { error: 'json_required' });
  }
  const signature = request.headers.get('sentry-hook-signature');
  // Reject unauthenticated probes before accessing any deployment configuration.
  if (!/^[a-f0-9]{64}$/.test(signature ?? '')) return reply(401, { error: 'signature_required' });

  try {
    const body = await readBody(request);
    const { webhookSecret, projectId } = getConfig();
    if (typeof webhookSecret !== 'string' || !webhookSecret ||
        typeof projectId !== 'string' || numericId(projectId) !== projectId) {
      return reply(503, { error: 'sentry_receiver_unavailable' });
    }
    const event = parseSentryAlert({ body, signature, resource: request.headers.get('sentry-hook-resource'),
      webhookSecret, projectId });
    if (!event) return reply(202, { status: 'ignored' });

    const receipt = { status: 'verified', receiptId: event.eventId, processing: 'not_connected' };
    await onVerified(receipt);
    return reply(200, receipt);
  } catch (error) {
    if (error instanceof DeliveryError) return reply(error.status, { error: error.message });
    // Never return/log the payload, signature, configuration or exception text.
    return reply(503, { error: 'sentry_delivery_unconfirmed' });
  }
}
