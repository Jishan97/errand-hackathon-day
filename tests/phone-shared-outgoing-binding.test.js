import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createApp } from "../src/phone/app.js";
import { loadConfig } from "../src/phone/config.js";
import { createM1VoiceController } from "../src/phone/voice/m1-controller.js";
import { placeTestCall } from "../src/phone/voice/twilio.js";
import { createAssistantWorker } from "../src/phone/assistant/worker.js";
import { environment, signature, callSid } from "./helpers/phone-voice-fixture.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const otherJob = "22222222-2222-4222-8222-222222222222";
function configuration() {
  return loadConfig({ ...environment, ENABLE_M1_INTAKE: "true", ENABLE_SHARED_ASSISTANT: "true",
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEY: "sb_" + "secret_fixture_secret_0000000000000000" });
}

async function fixture(t) {
  const effects = [];
  const config = configuration();
  const controller = createM1VoiceController({ config, contextRepository: {},
    repository: { async admitDemoCall(input) { effects.push({ type: "admit", input }); return { call_id: jobId, resident_id: otherJob, admitted: true, admission_method: "allowed_test_number" }; } },
    assistant: { async bindCallback(sid, job) { effects.push({ type: "bind", sid, job }); } },
  });
  const server = createServer(createApp({ config, logger() {}, m1: controller }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function outgoing(suffix, { signedSuffix = suffix, unsigned = false, fields: overrides = {} } = {}) {
    const fields = { AccountSid: environment.TWILIO_ACCOUNT_SID, CallSid: callSid,
      From: environment.TWILIO_FROM_NUMBER, To: environment.TEST_RESIDENT_NUMBER, Direction: "outbound-api", ...overrides };
    return fetch(origin + "/api/voice/outgoing" + suffix, { method: "POST", headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(!unsigned ? { "X-Twilio-Signature": signature(environment.PUBLIC_BASE_URL + "/api/voice/outgoing" + signedSuffix, fields) } : {}),
    }, body: new URLSearchParams(fields).toString() });
  }
  return { outgoing, effects };
}

test("signed outgoing job is bound after number-only admission and before direct connection without disclosing its task", async (t) => {
  const f = await fixture(t);
  const response = await f.outgoing(`?job=${jobId}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("<Gather"));
  assert.match(body, /<Redirect method="POST">https:\/\/errand.example\/api\/voice\/connect<\/Redirect>/);
  assert.ok(!body.includes(jobId));
  assert.deepEqual(f.effects, [
    { type: "admit", input: { callSid, direction: "outbound" } },
    { type: "bind", sid: callSid, job: jobId },
  ]);
});

test("callback signature, account, fixed numbers and direction are checked before admission or job binding", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.outgoing(`?job=${jobId}`, { unsigned: true })).status, 403);
  assert.equal((await f.outgoing(`?job=${otherJob}`, { signedSuffix: `?job=${jobId}` })).status, 403);
  for (const fields of [
    { AccountSid: `AC${"f".repeat(32)}` }, { CallSid: "not-a-call" },
    { From: "+12025550199" }, { To: "+12025550199" },
    { Direction: "outbound-dial" },
    { Direction: "inbound", From: environment.TEST_RESIDENT_NUMBER, To: environment.TWILIO_FROM_NUMBER },
  ]) assert.equal((await f.outgoing(`?job=${jobId}`, { fields })).status, 403);
  assert.deepEqual(f.effects, []);
});

test("callback binding rejects invalid, duplicate and unrelated query parameters", async (t) => {
  const f = await fixture(t);
  for (const query of ["?job=not-a-job", `?job=${jobId}&job=${otherJob}`, `?job=${jobId}&extra=true`, `?task=${jobId}`]) {
    assert.equal((await f.outgoing(query)).status, 400);
  }
  assert.deepEqual(f.effects, []);
});

test("ordinary signed outgoing call remains supported without a job binding", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.outgoing("")).status, 200);
  assert.deepEqual(f.effects, [{ type: "admit", input: { callSid, direction: "outbound" } }]);
});

test("Twilio submission pins the callback job in its outgoing webhook URL", async () => {
  let submitted;
  const result = await placeTestCall(configuration(), { jobId, fetcher: async (url, options) => {
    submitted = { url, form: new URLSearchParams(options.body) };
    return Response.json({ sid: callSid });
  } });
  assert.equal(result.call_sid, callSid);
  assert.equal(submitted.form.get("Url"), `${environment.PUBLIC_BASE_URL}/api/voice/outgoing?job=${jobId}`);
  assert.equal(submitted.form.get("To"), environment.TEST_RESIDENT_NUMBER);
  assert.equal(submitted.form.get("From"), environment.TWILIO_FROM_NUMBER);
});

test("worker forwards the claimed job ID to the callback transport", async () => {
  let submitted;
  const job = { status: "claimed", id: jobId, operation: "callback" };
  const worker = createAssistantWorker({ config: {}, repository: { claim: async () => job, finish: async () => {} },
    placeCall: async (config, options) => { submitted = options; return { call_sid: callSid }; } });
  assert.equal((await worker.run()).status, "processed");
  assert.deepEqual(submitted, { jobId });
});
