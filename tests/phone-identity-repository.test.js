import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentityRepository, IdentityRepositoryError } from "../src/phone/storage/identity-repository.js";

const callSid = `CA${"a".repeat(32)}`;
const streamSid = `MZ${"b".repeat(32)}`;
const callId = "11111111-1111-4111-8111-111111111111";
const residentId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const challengeId = "44444444-4444-4444-8444-444444444444";
const nonce = "55555555-5555-4555-8555-555555555555";
const privateText = "fixture-private-pin-or-provider-error";
const challenge = (extra = {}) => ({ call_id: callId, resident_id: residentId, challenge_id: challengeId, attempts_left: 3, verified: false, ...extra });
const binding = (extra = {}) => ({ call_id: callId, resident_id: residentId, task_id: taskId, direction: "inbound", ...extra });
const inputs = {
  beginCall: { callSid, direction: "inbound" },
  authenticateCall: { callSid, challengeId, matched: true },
  getVerifiedCall: { callSid },
  issueStream: { callSid, nonce },
  consumeStream: { callSid, nonce, streamSid },
};

function safeCode(code) {
  return (error) => {
    assert.ok(error instanceof IdentityRepositoryError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    for (const excluded of [privateText, callSid, streamSid, residentId, challengeId, nonce]) {
      assert.ok(!String(error.stack).includes(excluded));
      assert.ok(!JSON.stringify(error).includes(excluded));
    }
    return true;
  };
}

test("identity operations use exactly the agreed fixed RPC names and allowlisted arguments", async () => {
  const sent = [];
  const repository = createIdentityRepository({ rpc: async (name, parameters) => {
    sent.push({ name, parameters });
    return /begin_call|authenticate_call/.test(name) ? challenge() : binding();
  } });
  for (const [method, input] of Object.entries(inputs)) await repository[method]({ ...input, pin: privateText, token: privateText, rpcName: "arbitrary_rpc" });
  assert.deepEqual(sent, [
    { name: "errand_begin_call", parameters: { p_provider_call_id: callSid, p_direction: "inbound" } },
    { name: "errand_authenticate_call", parameters: { p_provider_call_id: callSid, p_challenge_id: challengeId, p_matched: true } },
    { name: "errand_get_verified_call", parameters: { p_provider_call_id: callSid } },
    { name: "errand_issue_stream", parameters: { p_provider_call_id: callSid, p_nonce: nonce } },
    { name: "errand_consume_stream", parameters: { p_provider_call_id: callSid, p_nonce: nonce, p_provider_stream_id: streamSid } },
  ]);
  assert.ok(!JSON.stringify(sent).includes(privateText));
  assert.ok(Object.isFrozen(repository));
});

test("challenge results preserve snake_case success, failure, and locked shapes without private fields", async () => {
  for (const result of [challenge(), challenge({ challenge_id: null, attempts_left: 0 }), challenge({ verified: true, challenge_id: null })]) {
    for (const method of ["beginCall", "authenticateCall"]) {
      const repository = createIdentityRepository({ rpc: async () => ({ ...result, pin_hash: privateText, private_error: privateText }) });
      const returned = await repository[method](inputs[method]);
      assert.deepEqual(returned, result);
      assert.ok(Object.isFrozen(returned));
      assert.ok(!JSON.stringify(returned).includes(privateText));
    }
  }
});

test("verified binding operations support optional task IDs and each permitted direction", async () => {
  for (const task_id of [null, taskId]) {
    for (const direction of ["inbound", "outbound"]) {
      for (const method of ["getVerifiedCall", "issueStream", "consumeStream"]) {
        const result = binding({ task_id, direction });
        const repository = createIdentityRepository({ rpc: async () => ({ ...result, phone: privateText, verification_code_hash: privateText }) });
        assert.deepEqual(await repository[method](inputs[method]), result);
      }
    }
  }
});

test("both match outcomes are booleans, and the adapter never receives or derives PIN text", async () => {
  for (const matched of [false, true]) {
    const repository = createIdentityRepository({ rpc: async (name, parameters) => {
      assert.equal(parameters.p_matched, matched);
      assert.deepEqual(Object.keys(parameters).sort(), ["p_challenge_id", "p_matched", "p_provider_call_id"]);
      return challenge({ verified: matched });
    } });
    const input = Object.defineProperty({ callSid, challengeId, matched }, "pin", { get() { throw new Error(privateText); } });
    assert.equal((await repository.authenticateCall(input)).verified, matched);
  }
});

test("invalid Twilio call IDs fail locally for every operation", async () => {
  const repository = createIdentityRepository({ rpc: () => assert.fail("Invalid input must not reach RPC") });
  for (const method of Object.keys(inputs)) {
    for (const invalid of [undefined, null, "", "CAshort", `CA${"z".repeat(32)}`, `ca${"a".repeat(32)}`, `${callSid}\n`, {}, 42]) {
      await assert.rejects(repository[method]({ ...inputs[method], callSid: invalid }), safeCode("invalid_identity_binding"));
    }
  }
});

test("challenge and nonce UUIDs, stream IDs, directions and match types are checked before RPC", async () => {
  const repository = createIdentityRepository({ rpc: () => assert.fail("Invalid input must not reach RPC") });
  for (const [method, key, values] of [
    ["beginCall", "direction", [undefined, null, "incoming", "worker", true]],
    ["authenticateCall", "challengeId", [undefined, null, "", "not-a-uuid", `${challengeId}\n`]],
    ["authenticateCall", "matched", [undefined, null, "true", 1, 0]],
    ["issueStream", "nonce", [undefined, null, "", "not-a-uuid", `${nonce}\n`]],
    ["consumeStream", "nonce", [undefined, null, "", "not-a-uuid"]],
    ["consumeStream", "streamSid", [undefined, null, "", callSid, `MZ${"z".repeat(32)}`, `${streamSid}\n`]],
  ]) {
    for (const value of values) await assert.rejects(repository[method]({ ...inputs[method], [key]: value }), safeCode("invalid_identity_binding"));
  }
});

test("malformed input records and accessor values expose only fixed safe errors", async () => {
  const repository = createIdentityRepository({ rpc: () => assert.fail("Invalid input must not reach RPC") });
  for (const method of Object.keys(inputs)) {
    for (const input of [undefined, null, [], {}, Object.defineProperty({ ...inputs[method] }, "callSid", { get() { throw new Error(privateText); } })]) {
      await assert.rejects(repository[method](input), safeCode("invalid_identity_binding"));
    }
  }
});

test("every successful response still needs its common owned record UUIDs", async () => {
  for (const method of Object.keys(inputs)) {
    const base = /beginCall|authenticateCall/.test(method) ? challenge() : binding();
    for (const result of [null, [], "private response", 1, false, { ...base, call_id: null }, { ...base, resident_id: "other-owner-not-a-uuid" }]) {
      const repository = createIdentityRepository({ rpc: async () => result });
      await assert.rejects(repository[method](inputs[method]), safeCode("invalid_identity_response"));
    }
  }
});

test("challenge results require declared nullable UUIDs, bounded attempts and exact booleans", async () => {
  for (const change of [
    { challenge_id: undefined }, { challenge_id: "invalid" }, { verified: undefined }, { verified: "true" },
    { attempts_left: -1 }, { attempts_left: 4 }, { attempts_left: 0.5 }, { attempts_left: "3" }, { attempts_left: undefined },
  ]) {
    const repository = createIdentityRepository({ rpc: async () => challenge(change) });
    await assert.rejects(repository.authenticateCall(inputs.authenticateCall), safeCode("invalid_identity_response"));
  }
});

test("verified binding responses require task nullability and a valid direction", async () => {
  for (const change of [{ task_id: undefined }, { task_id: "invalid" }, { direction: undefined }, { direction: "incoming" }]) {
    const repository = createIdentityRepository({ rpc: async () => binding(change) });
    await assert.rejects(repository.getVerifiedCall(inputs.getVerifiedCall), safeCode("invalid_identity_response"));
  }
});

test("RPC failures and lost mutation responses are redacted and never automatically retried", async () => {
  for (const method of Object.keys(inputs)) {
    let attempts = 0;
    const repository = createIdentityRepository({ rpc: async () => { attempts += 1; throw new Error(`${privateText}:${callSid}:${nonce}`); } });
    await assert.rejects(repository[method](inputs[method]), safeCode("identity_request_failed"));
    assert.equal(attempts, 1);
  }
});

test("malformed response accessors cannot surface provider errors", async () => {
  const result = Object.defineProperty(challenge(), "resident_id", { get() { throw new Error(privateText); } });
  const repository = createIdentityRepository({ rpc: async () => result });
  await assert.rejects(repository.beginCall(inputs.beginCall), safeCode("invalid_identity_response"));
});

test("construction requires only an injected RPC and causes no request", () => {
  for (const options of [undefined, null, {}, { rpc: null }, { rpc: "rpc" }, Object.defineProperty({}, "rpc", { get() { throw new Error(privateText); } })]) {
    assert.throws(() => createIdentityRepository(options), safeCode("invalid_identity_repository"));
  }
  assert.doesNotThrow(() => createIdentityRepository({ rpc: () => assert.fail("No request during construction") }));
});
