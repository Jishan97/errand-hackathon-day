import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import twilio from "twilio";

export const callSidPattern = /^CA[0-9a-f]{32}$/i;
export const streamSidPattern = /^MZ[0-9a-f]{32}$/i;

function equalStrings(actual, expected) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function validateTwilioSignature({ signature, url, parameters = {}, authToken }) {
  if (!authToken || !signature || signature.length > 64) return false;
  if (typeof signature !== "string") return false;
  return twilio.validateRequest(authToken, signature, url, parameters);
}

export function validateStreamSignature(signature, config) {
  const canonical = `${config.values.PUBLIC_BASE_URL}/api/media`;
  return [canonical, `${canonical}/`, canonical.replace("https:", "wss:"), `${canonical.replace("https:", "wss:")}/`]
    .some((url) => validateTwilioSignature({ signature, url, authToken: config.values.TWILIO_AUTH_TOKEN }));
}

export function createStreamToken(config, callSid, direction, now = Date.now()) {
  const claims = {
    version: 1,
    account: config.values.TWILIO_ACCOUNT_SID,
    call: callSid,
    direction,
    expires: now + 60_000,
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", config.values.STREAM_TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyStreamToken(token, config, callSid, now = Date.now()) {
  if (config.m1Enabled) return verifyResidentStreamToken(token, config, callSid, now);
  if (typeof token !== "string" || token.length > 480 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
  const [payload, signature] = token.split(".");
  const expected = createHmac("sha256", config.values.STREAM_TOKEN_SECRET).update(payload).digest("base64url");
  if (!equalStrings(signature, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }

  if (
    claims?.version !== 1 || claims.account !== config.values.TWILIO_ACCOUNT_SID ||
    claims.call !== callSid || !callSidPattern.test(claims.call) ||
    !["inbound", "outbound"].includes(claims.direction) ||
    !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires > now + 60_000 ||
    typeof claims.nonce !== "string" || !/^[\w-]{22}$/.test(claims.nonce)
  ) return null;

  return claims;
}

// M1 capabilities use their own HMAC domain and a durable database nonce. An M0
// token can never be upgraded into a verified resident session.
export function createResidentStreamToken(config, callSid, direction, nonce, now = Date.now()) {
  if (!callSidPattern.test(callSid) || !["inbound", "outbound"].includes(direction)
    || typeof nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce)) throw new Error("invalid_resident_stream_binding");
  const claims = { version: 2, account: config.values.TWILIO_ACCOUNT_SID, call: callSid, direction, expires: now + 60_000, nonce };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", config.values.STREAM_TOKEN_SECRET).update(`m1-stream:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyResidentStreamToken(token, config, callSid, now = Date.now()) {
  if (typeof token !== "string" || token.length > 480 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
  const [payload, signature] = token.split(".");
  const expected = createHmac("sha256", config.values.STREAM_TOKEN_SECRET).update(`m1-stream:${payload}`).digest("base64url");
  if (!equalStrings(signature, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (claims.version !== 2 || claims.account !== config.values.TWILIO_ACCOUNT_SID || claims.call !== callSid
      || !callSidPattern.test(callSid) || !["inbound", "outbound"].includes(claims.direction)
      || !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires > now + 60_000
      || typeof claims.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claims.nonce)) return null;
    return claims;
  } catch { return null; }
}
