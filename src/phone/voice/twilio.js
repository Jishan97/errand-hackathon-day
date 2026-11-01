import { voiceIsAvailable } from "../config.js";
import { callSidPattern, createStreamToken, validateTwilioSignature } from "./security.js";

function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);
}

export function createVoiceWebhook(config, direction) {
  const route = direction === "inbound" ? "/api/voice/incoming" : "/api/voice/outgoing";

  return (request, response) => {
    if (!voiceIsAvailable(config)) return response.status(503).json({ error: { code: "voice_disabled_or_unconfigured" } });
    if (request.originalUrl !== route) return response.status(400).json({ error: { code: "invalid_voice_url" } });
    if (typeof request.body !== "string") return response.status(415).json({ error: { code: "form_body_required" } });

    const fields = new URLSearchParams(request.body);
    const parameters = Object.create(null);
    if (fields.size > 64) return response.status(400).json({ error: { code: "invalid_voice_form" } });
    for (const [name, value] of fields) {
      if (Object.hasOwn(parameters, name)) return response.status(400).json({ error: { code: "invalid_voice_form" } });
      parameters[name] = value;
    }

    if (!validateTwilioSignature({
      signature: request.headers["x-twilio-signature"],
      url: `${config.values.PUBLIC_BASE_URL}${route}`,
      parameters,
      authToken: config.values.TWILIO_AUTH_TOKEN,
    })) return response.status(403).json({ error: { code: "invalid_twilio_signature" } });

    const expectedFrom = direction === "inbound" ? config.values.TEST_RESIDENT_NUMBER : config.values.TWILIO_FROM_NUMBER;
    const expectedTo = direction === "inbound" ? config.values.TWILIO_FROM_NUMBER : config.values.TEST_RESIDENT_NUMBER;
    const expectedDirection = direction === "inbound" ? "inbound" : "outbound-api";
    if (
      parameters.AccountSid !== config.values.TWILIO_ACCOUNT_SID || !callSidPattern.test(parameters.CallSid ?? "") ||
      parameters.From !== expectedFrom || parameters.To !== expectedTo || parameters.Direction !== expectedDirection
    ) return response.status(403).json({ error: { code: "test_call_not_allowed" } });

    const token = createStreamToken(config, parameters.CallSid, direction);
    const mediaUrl = `${config.values.PUBLIC_BASE_URL.replace("https:", "wss:")}/api/media`;
    response.type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Say>This is Errand, an AI assistant, in a short voice connection test. No repair task will be saved and no email will be sent. Please use fictional details only.</Say>` +
      `<Connect><Stream url="${escapeXml(mediaUrl)}"><Parameter name="bridgeToken" value="${escapeXml(token)}"/></Stream></Connect>` +
      `<Say>The voice test has ended. No repair task was saved. Goodbye.</Say><Hangup/></Response>`,
    );
  };
}

export async function placeTestCall(config, { fetcher = fetch, jobId = null } = {}) {
  if (!voiceIsAvailable(config)) throw new Error("Voice is disabled or unconfigured.");
  if (jobId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw new Error("Invalid callback job binding.");
  const parameters = new URLSearchParams({
    From: config.values.TWILIO_FROM_NUMBER,
    To: config.values.TEST_RESIDENT_NUMBER,
    Url: `${config.values.PUBLIC_BASE_URL}/api/voice/outgoing${jobId ? `?job=${jobId}` : ""}`,
    Method: "POST",
    Timeout: "20",
    TimeLimit: "290",
  });
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.values.TWILIO_ACCOUNT_SID}/Calls.json`;
  let response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.values.TWILIO_ACCOUNT_SID}:${config.values.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: parameters.toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new Error("Call submission outcome is unknown. Check Twilio before retrying.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Twilio did not confirm the test call. Check Twilio before retrying.");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Call submission outcome is unknown. Check Twilio before retrying.");
  }
  if (!callSidPattern.test(result?.sid ?? "")) throw new Error("Call submission outcome is unknown. Check Twilio before retrying.");
  return { call_sid: result.sid, status: "submitted_not_verified" };
}
