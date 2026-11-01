import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, getReadiness } from "../src/phone/config.js";
import { createStreamToken, validateTwilioSignature, verifyStreamToken } from "../src/phone/voice/security.js";
import { placeTestCall } from "../src/phone/voice/twilio.js";
import { callSid, environment, signature, startVoiceFixture } from "./helpers/phone-voice-fixture.js";

test("Twilio signatures cover every form field and the canonical URL", () => {
  const url = "https://errand.example/api/voice/incoming";
  const parameters = { CallSid: callSid, From: environment.TEST_RESIDENT_NUMBER, Extra: " untrimmed " };
  const signed = signature(url, parameters);
  const validate = (changes) => validateTwilioSignature({ signature: signed, url, parameters, authToken: environment.TWILIO_AUTH_TOKEN, ...changes });
  assert.equal(validate({}), true);
  assert.equal(validate({ parameters: { ...parameters, Extra: "untrimmed" } }), false);
  assert.equal(validate({ url: "https://attacker.example/api/voice/incoming" }), false);
  assert.equal(validate({ signature: "invalid" }), false);
  assert.equal(validate({ authToken: "" }), false);
});

test("stream tokens expire, bind the call/account, and detect tampering", () => {
  const config = loadConfig(environment);
  const now = Date.now();
  const token = createStreamToken(config, callSid, "inbound", now);
  assert.equal(verifyStreamToken(token, config, callSid, now).direction, "inbound");
  assert.equal(verifyStreamToken(token, config, callSid, now + 60_000), null);
  assert.equal(verifyStreamToken(token, config, `CA${"d".repeat(32)}`, now), null);
  assert.equal(verifyStreamToken(`${token.slice(0, -2)}aa`, config, callSid, now), null);
  assert.equal(verifyStreamToken(token, loadConfig({ ...environment, TWILIO_ACCOUNT_SID: `AC${"d".repeat(32)}` }), callSid, now), null);
  assert.equal(verifyStreamToken("invalid", config, callSid, now), null);
  assert.ok(token.length + "bridgeToken".length < 500);
  assert.ok(!Buffer.from(token.split(".")[0], "base64url").toString().includes(environment.TEST_RESIDENT_NUMBER));
});

for (const direction of ["inbound", "outbound"]) {
  test(`a signed allowed ${direction} webhook returns bound TwiML, not a provider connection`, async (context) => {
    const fixture = await startVoiceFixture(context);
    const response = await fixture.webhook({ direction, headers: { "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http" } });
    assert.equal(response.status, 200);
    const xml = await response.text();
    const token = xml.match(/name="bridgeToken" value="([\w.-]+)"/)[1];
    assert.equal(verifyStreamToken(token, fixture.config, callSid).direction, direction);
    assert.match(xml, /wss:\/\/errand.example\/api\/media/);
    assert.match(xml, /AI assistant/);
    assert.match(xml, /<Hangup\/>/);
    assert.ok(!xml.includes(environment.OPENAI_API_KEY));
    assert.ok(!xml.includes("attacker.example"));
    assert.equal(fixture.providerAttempts(), 0);
  });
}

for (const fields of [
  { From: "+12025550199" }, { To: "+12025550199" },
  { AccountSid: `AC${"d".repeat(32)}` }, { CallSid: "not-a-call" }, { Direction: "outbound-api" },
]) {
  test(`signed webhook rejects an unapproved ${Object.keys(fields)[0]}`, async (context) => {
    const fixture = await startVoiceFixture(context);
    const response = await fixture.webhook({ fields });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "test_call_not_allowed");
    assert.equal(fixture.providerAttempts(), 0);
  });
}

test("unsigned, duplicate, wrong-content-type, query and oversized forms are rejected", async (context) => {
  const fixture = await startVoiceFixture(context);
  for (const [options, status] of [
    [{ headers: { "X-Twilio-Signature": "invalid" } }, 403],
    [{ rawBody: "CallSid=one&CallSid=two" }, 400],
    [{ headers: { "Content-Type": "application/json" } }, 415],
    [{ suffix: "?token=not-authorization" }, 400],
    [{ rawBody: "field=" + "x".repeat(16 * 1024) }, 413],
  ]) {
    const response = await fixture.webhook(options);
    assert.equal(response.status, status);
    await response.body.cancel();
  }
  assert.equal((await fetch(`${fixture.origin}/api/voice/incoming`)).status, 405);
  assert.equal(fixture.providerAttempts(), 0);
});

test("outbound submission uses only the fixed test numbers and does not retry", async () => {
  let submissions = 0;
  const config = loadConfig(environment);
  const result = await placeTestCall(config, { fetcher: async (url, options) => {
    submissions += 1;
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${environment.TWILIO_ACCOUNT_SID}/Calls.json`);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("To"), environment.TEST_RESIDENT_NUMBER);
    assert.equal(form.get("From"), environment.TWILIO_FROM_NUMBER);
    assert.equal(form.get("TimeLimit"), "290");
    assert.equal(form.get("Url"), `${environment.PUBLIC_BASE_URL}/api/voice/outgoing`);
    assert.equal(options.redirect, "error");
    return Response.json({ sid: callSid, status: "queued" });
  } });
  assert.equal(submissions, 1);
  assert.deepEqual(result, { call_sid: callSid, status: "submitted_not_verified" });
  assert.ok(!JSON.stringify(result).includes(environment.TEST_RESIDENT_NUMBER));
  const readiness = getReadiness(config);
  assert.equal(readiness.external_actions.calls, true);
  assert.ok(Object.values(readiness.live_acceptance).every((status) => status === "pending"));
});

test("disabled or ambiguous outbound submission never falls back or retries", async () => {
  let submissions = 0;
  const fetcher = async () => { submissions += 1; throw new Error("private-provider-content"); };
  await assert.rejects(placeTestCall(loadConfig({}), { fetcher }), /disabled or unconfigured/);
  assert.equal(submissions, 0);
  await assert.rejects(placeTestCall(loadConfig(environment), { fetcher }), /outcome is unknown/);
  assert.equal(submissions, 1);
});
