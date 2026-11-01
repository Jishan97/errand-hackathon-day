import { createHash, timingSafeEqual } from 'node:crypto';

export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare';
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export class ImageFailure extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ImageFailure(code, status); };
export async function boundedBytes(stream, max) {
  const reader = stream?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); fail('image_response_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || !value.isWellFormed()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('invalid_prompt', 400);
  return value.trim();
}

// Reusable by the shared phone worker. Credentials/config remain server-owned.
// No automatic retry: a timeout can still have generated a billable image.
export async function generateImage({ prompt, apiKey, model = DEFAULT_IMAGE_MODEL, fetcher = fetch }) {
  prompt = validatePrompt(prompt);
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('image_setup_required');
  if (typeof model !== 'string' || !/^gpt-image-[a-zA-Z0-9.-]+$/.test(model)) fail('image_model_invalid');
  let response;
  try {
    response = await fetcher('https://api.openai.com/v1/images/generations', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024', quality: 'low',
        output_format: 'jpeg', output_compression: 80 }),
    });
    const raw = await boundedBytes(response.body, 5 * 1024 * 1024);
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { fail('image_provider_unavailable', 502); }
    if (!response.ok) {
      if (data.error?.code === 'moderation_blocked' || data.error?.code === 'content_policy_violation') fail('image_request_blocked', 422);
      if (response.status === 429) fail('image_rate_limited', 429);
      if ([401, 403, 404].includes(response.status)) fail('image_access_required');
      fail('image_provider_unavailable', 502);
    }
    const encoded = data.data?.[0]?.b64_json;
    if (!Array.isArray(data.data) || data.data.length !== 1 || typeof encoded !== 'string'
      || !encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('image_provider_unavailable', 502);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) fail('image_response_too_large', 413);
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216
      || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('image_provider_unavailable', 502);
    return { bytes, contentType: 'image/jpeg', filename: 'errand-image.jpg' };
  } catch (error) {
    if (error instanceof ImageFailure) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') fail('image_generation_timed_out', 504);
    fail('image_provider_unavailable', 502);
  }
}

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (status, error) => Response.json({ error }, { status, headers });
export function checkImageOperator(request, getToken) {
  const supplied = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  if (!supplied) fail('operator_required', 401);
  const expected = getToken();
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(expected)) fail('image_setup_required', 503);
  const hash = value => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(hash(expected), hash(supplied))) fail('operator_rejected', 403);
}
export async function handleImageGeneration(request, { getToken = () => undefined,
  getConfig = () => ({}), generate = generateImage } = {}) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
  try {
    checkImageOperator(request, getToken);
    if (new URL(request.url).search) return json(400, 'invalid_request');
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json(415, 'json_required');
    if (Number(request.headers.get('content-length')) > 10000) return json(413, 'body_too_large');
    let body;
    try { body = JSON.parse((await boundedBytes(request.body, 10000)).toString('utf8')); }
    catch (error) { return json(error instanceof ImageFailure ? 413 : 400, error instanceof ImageFailure ? 'body_too_large' : 'invalid_json'); }
    if (!body || Array.isArray(body) || Object.keys(body).join() !== 'prompt') return json(400, 'invalid_request');
    const prompt = validatePrompt(body.prompt);
    const config = getConfig();
    const result = await generate({ prompt, apiKey: config.apiKey, model: config.model });
    return new Response(result.bytes, { status: 200, headers: { ...headers,
      'Content-Type': result.contentType, 'Content-Disposition': `inline; filename="${result.filename}"` } });
  } catch (error) {
    return json(error instanceof ImageFailure ? error.status : 503,
      error instanceof ImageFailure ? error.code : 'image_provider_unavailable');
  }
}
