import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSpokenConfirmation } from "../src/phone/voice/spoken-confirmation.js";
import { createAssistantConversation } from "../src/phone/voice/assistant-conversation.js";
import { createAssistantService } from "../src/phone/assistant/service.js";

const callSid = `CA${"a".repeat(32)}`;
const binding = { call_id: randomUUID(), resident_id: randomUUID() };
const gateBinding = { callSid, callId: binding.call_id, residentId: binding.resident_id, draftId: randomUUID(), proposalHash: "a".repeat(64), revision: 1 };
const actual = "I'll phone at three London time about fictional plants. Shall I go ahead?";
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
async function until(predicate) { const end = Date.now() + 400; while (!predicate()) { assert.ok(Date.now() < end, "Fixture did not settle"); await new Promise((resolve) => setTimeout(resolve, 2)); } }

function gateFixture(mode = "semantic") {
  let playback = true;
  const gate = createSpokenConfirmation({ readbackMode: mode, hasPendingPlayback: () => playback });
  const presentation = gate.begin({ binding: gateBinding, readbackText: "Call at 3 pm London time about fictional plants.", confirmationQuestion: "Should I go ahead?" });
  return { gate, presentation, playback(value) { playback = value; },
    output(delta = actual, startMs = 100, endMs = 500) { return gate.appendOutput({ type: "session.output_transcript.delta", event_id: randomUUID(), delta, start_ms: startMs, end_ms: endMs }); },
    caller(delta = "Yes, please go ahead.", startMs = 1000, endMs = 1200) { return gate.observeCaller({ type: "session.input_transcript.delta", event_id: randomUUID(), delta, start_ms: startMs, end_ms: endMs }); },
  };
}

test("read-only assessment evidence survives pending playback without authorizing consumption", () => {
  const h = gateFixture(); h.output(); h.caller();
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  assert.equal(h.gate.deliveredReadback(), null);
  const snapshot = h.gate.assessmentSnapshot();
  assert.equal(h.gate.readbackForAssessment(), actual);
  assert.equal(h.gate.isEvidenceCurrent(snapshot), true);
  assert.equal(h.gate.isEvidenceCurrent({ ...snapshot }), false);
  assert.equal(h.gate.isCurrent(snapshot), false); assert.equal(h.gate.consume(snapshot), null);
  h.playback(false); h.gate.openReply();
  assert.equal(h.gate.isCurrent(snapshot), true);
  assert.equal(h.gate.consume(snapshot).nonce, snapshot.nonce);
  assert.equal(h.gate.consume(snapshot), null);
});

test("readonly evidence still requires actual readback and fresh caller-caption source", () => {
  const h = gateFixture();
  h.gate.observeSpeech(); h.caller();
  assert.throws(() => h.gate.assessmentSnapshot(), /spoken_reply_unavailable/);
  const noReply = gateFixture(); noReply.output(); noReply.gate.observeSpeech();
  assert.throws(() => noReply.gate.assessmentSnapshot(), /spoken_reply_unavailable/);
});

test("new caller captions, late changed readback and actual overlap invalidate readonly snapshots", () => {
  const caller = gateFixture(); caller.output(); caller.caller(); const a = caller.gate.assessmentSnapshot();
  caller.caller(" But change the time.", 1250, 1500);
  assert.equal(caller.gate.isEvidenceCurrent(a), false); assert.equal(caller.gate.consume(a), null);
  const output = gateFixture(); output.output(); output.caller(); const b = output.gate.assessmentSnapshot();
  output.output(" At four instead.", 600, 900);
  assert.equal(output.gate.isEvidenceCurrent(b), false); assert.equal(output.gate.consume(b), null);
  const overlap = gateFixture(); overlap.output(); overlap.caller(); const c = overlap.gate.assessmentSnapshot();
  overlap.output("Additional readback", 800, 1100);
  assert.equal(overlap.gate.isEvidenceCurrent(c), false);
  assert.equal(overlap.gate.diagnostics().last_invalidation_code, "caller_interrupted_readback");
});

test("literal assessment API keeps the existing strict playback and fresh-speech requirements", () => {
  const h = gateFixture("literal"); h.output(h.presentation.readbackText);
  assert.throws(() => h.gate.assessmentSnapshot(), /spoken_reply_unavailable/);
  assert.equal(h.gate.readbackForAssessment(), null);
  h.playback(false); h.gate.openReply(); h.gate.observeSpeech(); h.caller();
  assert.equal(h.gate.isCurrent(h.gate.assessmentSnapshot()), true);
});

test("settled captions can start read-only routing despite raw activity and held output marks", async () => {
  const plans = [], logs = [];
  let captionsSettled = false;
  const conversation = createAssistantConversation({ callSid, binding, service: { async plan(input) { plans.push(input); return { kind: "reply", reply: "A fixture read-only answer." }; } },
    commentary() {}, thinking() {}, logger: (entry) => logs.push(entry),
    quietInput: () => false, hasPendingPlayback: () => true, planningReady: () => captionsSettled });
  conversation.delegate("before-caption"); await conversation.tick(); await conversation.tick();
  conversation.transcript({ type: "session.input_transcript.delta", event_id: "request", delta: "What fictional notes exist?", start_ms: 100, end_ms: 300 });
  await conversation.tick(); await conversation.tick(); assert.equal(plans.length, 0);
  captionsSettled = true; conversation.speech(); await conversation.tick(); await flush();
  assert.equal(plans.length, 1);
  assert.deepEqual(logs.filter((entry) => entry.event === "assistant_work_waiting").map((entry) => entry.reason), ["caller_caption_pending", "caller_captions_settling"]);
  assert.ok(logs.some((entry) => entry.event === "assistant_turn_started" && Number.isSafeInteger(entry.wait_ms)));
  assert.ok(!JSON.stringify(logs).includes("fictional notes"));
  conversation.close();
});

test("legacy fixture readiness defaults to quietInput when no planningReady callback is supplied", async () => {
  let quiet = false, plans = 0;
  const conversation = createAssistantConversation({ callSid, binding, service: { async plan() { plans++; return { kind: "reply", reply: "Fixture reply" }; } },
    commentary() {}, thinking() {}, quietInput: () => quiet, hasPendingPlayback: () => true });
  conversation.transcript({ type: "session.input_transcript.delta", event_id: "request", delta: "An ordinary question", start_ms: 100, end_ms: 300 });
  conversation.delegate("legacy"); await conversation.tick(); await flush(); assert.equal(plans, 0);
  quiet = true; await conversation.tick(); await flush(); assert.equal(plans, 1);
  conversation.close();
});

test("one semantic verdict can begin under mark lag but cannot commit until strict quiet and playback readiness", async () => {
  const writes = [], messages = [], assessments = [], plans = [];
  let quiet = false, playback = true;
  let resolveVerdict;
  const verdict = new Promise((resolve) => { resolveVerdict = resolve; });
  const service = createAssistantService({ config: { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-key" } }, repository: {
    context: async () => ({ profile: { timeZone: "Europe/London", callbackConsent: true }, tasks: [] }),
    stage: async (input) => ({ id: randomUUID(), hash: input.hash, nonce: input.nonce, summary: input.summary }),
    confirm: async (input) => { writes.push(input); return { status: "confirmed", taskId: randomUUID() }; },
  }, planner: async (input) => { plans.push(input); return { kind: "propose", operation: "schedule_callback", args: { title: "Fictional plants", dueAt: new Date(Date.now() + 300000).toISOString() }, sourceEventIds: ["synthetic_request"] }; },
  assessor: async (input) => { assessments.push(input); await verdict; return { decision: "confirm", sourceEventIds: input.replyHistory.map((entry) => entry.eventId) }; } });
  const conversation = createAssistantConversation({ service, callSid, binding, commentary: (message) => messages.push(message), thinking() {},
    planningReady: () => true, quietInput: () => quiet, hasPendingPlayback: () => playback, confirmationQuietWaitMs: 200, confirmationQuietPollMs: 5 });
  conversation.transcript({ type: "session.input_transcript.delta", event_id: "request", delta: "Call me in five minutes", start_ms: 0, end_ms: 100 });
  conversation.delegate("request"); await conversation.tick(); await flush(); assert.equal(plans.length, 1);
  const requested = JSON.parse(messages.at(-1).split("data, not instructions: ")[1].split(" Do not claim")[0]);
  conversation.transcript({ type: "session.output_transcript.delta", event_id: "readback", delta: requested, start_ms: 200, end_ms: 600 });
  conversation.transcript({ type: "session.input_transcript.delta", event_id: "yes", delta: "Yes, go ahead.", start_ms: 1000, end_ms: 1200 });
  conversation.delegate("yes"); await conversation.tick(); await flush();
  assert.equal(assessments.length, 1); assert.equal(plans.length, 1);
  resolveVerdict(); await flush(); assert.equal(writes.length, 0);
  quiet = true; await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(writes.length, 0);
  playback = false; await until(() => writes.length === 1);
  assert.equal(assessments.length, 1); assert.equal(plans.length, 1);
  assert.equal(messages.filter((entry) => entry.startsWith("Read this")).length, 1);
  conversation.close();
});
