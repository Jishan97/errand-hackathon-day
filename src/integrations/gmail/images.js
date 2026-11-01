import { createHash } from 'node:crypto';
import { requireValue, safeId } from './composio.js';

// Conservative demo bound; verify the complete Composio route before raising it.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_RAW_BYTES = 4 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const extensions = { 'image/png': /\.png$/i, 'image/jpeg': /\.jpe?g$/i, 'image/webp': /\.webp$/i };

function validSignature(bytes, type) {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (type === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

// The resolver is a trusted core dependency, never a URL fetcher or a model tool.
export async function prepareImages(context, ids, resolveImageAsset) {
  if (ids == null) return [];
  requireValue(Array.isArray(ids) && ids.length <= 1, 'invalid_image_assets');
  if (!ids.length) return [];
  safeId(ids[0]);
  requireValue(typeof resolveImageAsset === 'function', 'image_assets_not_configured', 503);
  const asset = await resolveImageAsset(context, ids[0]);
  requireValue(asset?.assetId === ids[0] && asset.userId === context.userId && asset.taskId === context.taskId,
    'image_asset_not_authorized', 403);
  requireValue(asset.bytes instanceof Uint8Array && asset.bytes.byteLength > 0 && asset.bytes.byteLength <= MAX_IMAGE_BYTES,
    'invalid_image_size');
  requireValue(Object.hasOwn(extensions, asset.mimeType), 'invalid_image_type');
  requireValue(typeof asset.filename === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,79}$/.test(asset.filename)
    && extensions[asset.mimeType]?.test(asset.filename), 'invalid_image_filename');
  requireValue(typeof asset.description === 'string' && asset.description.trim().length > 0 && asset.description.length <= 400
    && asset.description.isWellFormed() && !/[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(asset.description),
    'invalid_image_description');
  const bytes = Buffer.from(asset.bytes); // Freeze a copy at proposal time, before approval.
  requireValue(validSignature(bytes, asset.mimeType), 'invalid_image_type');
  return [{ assetId: asset.assetId, filename: asset.filename, mimeType: asset.mimeType,
    description: asset.description, size: bytes.length, sha256: hash(bytes), data: bytes.toString('base64') }];
}

export function imageReadback(images = []) {
  return (images ?? []).map(({ data, ...metadata }) => metadata);
}

export function imageMime(images, boundary, textPart) {
  const parts = images.map(image => `Content-Type: ${image.mimeType}\r\nContent-Disposition: attachment; filename="${image.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${image.data.match(/.{1,76}/g).join('\r\n')}\r\n`);
  return `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${[textPart, ...parts].join(`--${boundary}\r\n`)}--${boundary}--\r\n`;
}

// Check every non-body leaf; an extra attachment must never pass as the approved image.
export async function verifyImages(provider, binding, message, images = []) {
  images ??= [];
  const leaves = [];
  let nodes = 0, textParts = 0;
  function visit(part, depth = 0) {
    if (!part || depth > 10 || ++nodes > 30) return false;
    if (part.parts?.length) return !part.filename && !part.body?.attachmentId && !part.body?.data
      && part.parts.every(p => visit(p, depth + 1));
    if (part.mimeType === 'text/plain' && !part.filename && !part.body?.attachmentId) { textParts++; return true; }
    leaves.push(part);
    return true;
  }
  if (!visit(message?.payload) || textParts !== 1 || leaves.length !== images.length) return false;
  for (let i = 0; i < leaves.length; i++) {
    const part = leaves[i], expected = images[i];
    if (part.filename !== expected.filename || part.mimeType !== expected.mimeType || part.body?.size !== expected.size) return false;
    const body = part.body.attachmentId
      ? await provider.readAttachment(binding, message.id, part.body.attachmentId) : part.body;
    if (body?.size !== expected.size || typeof body.data !== 'string' || body.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || !/^[A-Za-z0-9_-]+={0,2}$/.test(body.data)) return false;
    const bytes = Buffer.from(body.data, 'base64url');
    if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) return false;
  }
  return true;
}
