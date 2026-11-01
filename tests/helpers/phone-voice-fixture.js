import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../../src/phone/config.js";
import { createRuntime } from "../../src/phone/server.js";
import { voiceLimits } from "../../src/phone/voice/bridge.js";

export const callSid = `CA${"b".repeat(32)}`;
export const streamSid = `MZ${"c".repeat(32)}`;
export const environment = Object.freeze({
  ENABLE_LIVE_VOICE: "true",
  PUBLIC_BASE_URL: "https://errand.example",
  OPERATOR_TOKEN: "fixture-operator-secret-0000000000000000",
  STREAM_TOKEN_SECRET: "fixture-stream-secret-0000000000000000",
  OPENAI_API_KEY: "fixture-not-a-real-api-key",
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "fixture-not-a-real-auth-token",
  TWILIO_FROM_NUMBER: "+12025550101",
  TEST_RESIDENT_NUMBER: "+12025550102",
});

export function signature(url, parameters = {}, authToken = environment.TWILIO_AUTH_TOKEN) {
  const text = Object.keys(parameters).sort().reduce((value, key) => value + key + parameters[key], url);
  return createHmac("sha1", authToken).update(text).digest("base64");
}

export function collectMessages(socket) {
  const messages = [];
  const waiters = new Set();
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    messages.push(message);
    for (const waiter of [...waiters]) waiter(message);
  });
  return {
    messages,
    waitFor(type) {
      const existing = messages.find((message) => (message.type ?? message.event) === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Fixture did not receive ${type}.`));
        }, 3000);
        function waiter(message) {
          if ((message.type ?? message.event) !== type) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(message);
        }
        waiters.add(waiter);
      });
    },
  };
}

export async function startVoiceFixture(context, { autoStart = true, finalize = true, limits = {}, settings = {}, m1Options = {} } = {}) {
  const providerServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(providerServer, "listening");
  let resolveProvider;
  const providerReady = new Promise((resolve) => { resolveProvider = resolve; });
  const providers = [];
  const logs = [];
  let providerAttempts = 0;
  providerServer.on("connection", (socket) => {
    socket.on("error", () => {});
    const received = collectMessages(socket);
    const fixture = { socket, received, send: (event) => socket.send(JSON.stringify(event)) };
    providers.push(fixture);
    resolveProvider(fixture);
    socket.on("message", (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === "session.start" && autoStart) {
        const delay = event.session.delegation?.acknowledgement_delay_ms;
        if (delay !== undefined && (!Number.isInteger(delay) || delay < 0 || delay > 800)) {
          fixture.send({ type: "error", error: { code: "invalid_value", type: "invalid_request_error", param: "session.delegation.acknowledgement_delay_ms", message: "Acknowledgement delay is outside the API range." } });
          return;
        }
        fixture.send({ type: "session.started", session: { ...event.session, id: "fixture-live-session" } });
      }
      if (event.type === "session.close" && finalize) fixture.send({ type: "session.closed", usage: {} });
    });
  });
  const config = loadConfig({ ...environment, ...settings });
  const runtime = createRuntime({
    config,
    m1Options,
    logger: (entry) => logs.push(entry),
    voiceOptions: {
      limits: { ...voiceLimits, ...limits },
      connectProvider() {
        providerAttempts += 1;
        return new WebSocket(`ws://127.0.0.1:${providerServer.address().port}`, {
          maxPayload: 64 * 1024, perMessageDeflate: false,
        });
      },
    },
  });
  context.after(async () => {
    await runtime.close();
    for (const socket of providerServer.clients) socket.terminate();
    await new Promise((resolve) => providerServer.close(resolve));
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;

  async function webhook({ direction = "inbound", fields = {}, headers = {}, suffix = "", rawBody } = {}) {
    const route = direction === "inbound" ? "/api/voice/incoming" : "/api/voice/outgoing";
    const parameters = {
      AccountSid: environment.TWILIO_ACCOUNT_SID,
      CallSid: callSid,
      From: direction === "inbound" ? environment.TEST_RESIDENT_NUMBER : environment.TWILIO_FROM_NUMBER,
      To: direction === "inbound" ? environment.TWILIO_FROM_NUMBER : environment.TEST_RESIDENT_NUMBER,
      Direction: direction === "inbound" ? "inbound" : "outbound-api",
      ...fields,
    };
    return fetch(`${origin}${route}${suffix}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature(`${environment.PUBLIC_BASE_URL}${route}${suffix}`, parameters),
        ...headers,
      },
      body: rawBody ?? new URLSearchParams(parameters).toString(),
    });
  }

  async function openTelephone({ token, fields = {}, start = true, eventOverrides = {} } = {}) {
    if (!token) {
      const response = await webhook({ fields });
      assert.equal(response.status, 200);
      token = (await response.text()).match(/name="bridgeToken" value="([\w.-]+)"/)[1];
    }
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/media`, {
      headers: { "X-Twilio-Signature": signature(`${environment.PUBLIC_BASE_URL}/api/media`) },
      handshakeTimeout: 2000,
    });
    socket.on("error", () => {});
    const received = collectMessages(socket);
    const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    await once(socket, "open");
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    if (start) socket.send(JSON.stringify({
      event: "start", sequenceNumber: "1", streamSid,
      start: {
        accountSid: environment.TWILIO_ACCOUNT_SID, callSid: fields.CallSid ?? callSid, streamSid,
        tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { bridgeToken: token },
      },
      ...eventOverrides,
    }));
    let sequence = 1;
    return {
      socket, received, closed, token,
      send(event) { socket.send(JSON.stringify({ streamSid, sequenceNumber: String(++sequence), ...event })); },
      stop() { socket.send(JSON.stringify({ event: "stop", streamSid, sequenceNumber: String(++sequence), stop: { accountSid: environment.TWILIO_ACCOUNT_SID, callSid: fields.CallSid ?? callSid } })); },
    };
  }

  return { runtime, config, origin, logs, webhook, openTelephone, providerReady, providers, providerAttempts: () => providerAttempts };
}
