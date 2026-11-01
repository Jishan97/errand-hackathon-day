import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSpokenConfirmation } from "../src/phone/voice/spoken-confirmation.js";
import { createAssistantConversation } from "../src/phone/voice/assistant-conversation.js";

const binding = Object.freeze({ callSid: `CA${"a".repeat(32)}`, callId: randomUUID(), residentId: randomUUID(),
  draftId: randomUUID(), proposalHash: "a".repeat(64), revision: 1 });
const actualReadback = "I'll phone tomorrow at three London time about the fictional plants. Shall I go ahead?";

function gateFixture() {
  let pending = false;
  let id = 0;
  const gate = createSpokenConfirmation({ readbackMode: "semantic", hasPendingPlayback: () => pending });
  gate.begin({ binding, readbackText: "Call you tomorrow at 3 pm (Europe/London) about plants.", confirmationQuestion: "Should I go ahead?" });
  const event = (type, delta, startMs, endMs, eventId = `event_${++id}`) => ({ type: `session.${type}_transcript.delta`, event_id: eventId, delta, start_ms: startMs, end_ms: endMs });
  return { gate, playback(value) { pending = value; },
    output: (delta = actualReadback, startMs = 100, endMs = 500) => gate.appendOutput(event("output", delta, startMs, endMs)),
    caller: (delta = "Yes, please go ahead.", startMs = 1000, endMs = 1200) => gate.observeCaller(event("input", delta, startMs, endMs)),
    muted: (delta, startMs, endMs, eventId) => gate.observeMutedOutput(event("output", delta, startMs, endMs, eventId)),
  };
}

test("noise before and during readback preserves its actual text without producing permission", () => {
  const h = gateFixture();
  h.gate.observeSpeech(); h.playback(true); h.gate.observeSpeech();
  assert.equal(h.gate.snapshot().status, "collecting");
  h.output(); h.gate.observeSpeech();
  assert.equal(h.gate.snapshot().status, "matched");
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.playback(false); h.gate.openReply();
  assert.equal(h.gate.deliveredReadback(), actualReadback);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  assert.equal(h.gate.diagnostics().last_invalidation_code, null);
});

test("a late original request before first output is not mistaken for a reply or allowed to hide readback", () => {
  const h = gateFixture();
  h.caller("Please call me later.", 0, 90);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.output(actualReadback, 100, 500);
  assert.equal(h.gate.deliveredReadback(), actualReadback);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.caller("Yes, go ahead.", 1000, 1200);
  const reply = h.gate.replySnapshot();
  assert.deepEqual(reply.history.map((entry) => entry.text), ["Yes, go ahead."]);
});

test("a valid yes arriving before first readback caption remains provisional until actual output and playback", () => {
  const h = gateFixture(); h.playback(true);
  h.caller("Yes, go ahead.", 1000, 1200);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.output(actualReadback, 100, 500);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.playback(false);
  const reply = h.gate.replySnapshot();
  assert.equal(reply.history[0].text, "Yes, go ahead.");
  assert.equal(h.gate.deliveredReadback(), actualReadback);
});

test("a provisional caller caption overlapping first actual output fails closed", () => {
  const h = gateFixture(); h.caller("Yes", 400, 600);
  assert.equal(h.output(actualReadback, 100, 500).code, "caller_interrupted_readback");
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
});

test("muted ordering remains provisional until a first actual readback excludes old request captions", () => {
  const h = gateFixture(); h.caller("Old original request", 0, 90);
  assert.equal(h.muted("Unknown delivery", 600, 900).code, "muted_caption_order_pending");
  h.output(actualReadback, 100, 500);
  assert.equal(h.gate.diagnostics().unresolved_muted_fragments, 1);
  assert.equal(h.caller("Yes", 1000, 1200).code, "muted_pre_reply_readback_unverified");
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
});

test("actual post-readback caller text waits for lagging playback marks and never uses RMS as approval", () => {
  const h = gateFixture(); h.playback(true); h.output();
  h.caller();
  assert.equal(h.gate.diagnostics().candidate_reply_fragments, 1);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  assert.equal(h.gate.deliveredReadback(), null);
  h.playback(false);
  const snapshot = h.gate.replySnapshot();
  assert.equal(snapshot.history[0].text, "Yes, please go ahead.");
  assert.equal(h.gate.deliveredReadback(), actualReadback);
  assert.equal(h.gate.isCurrent(snapshot), true);
  assert.deepEqual(snapshot.binding, binding);
});

test("muted acknowledgment arriving before yes captions buffers timing only, then reconciles after-caller", () => {
  const h = gateFixture(); h.playback(true); h.output(); h.gate.observeSpeech();
  assert.equal(h.muted("SPECULATIVE AFTER-CALLER CLAIM", 1300, 1600).code, "muted_caption_order_pending");
  assert.equal(h.gate.diagnostics().status, "matched");
  assert.equal(h.gate.diagnostics().unresolved_muted_fragments, 1);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.caller("Yes, go ahead", 1000, 1200);
  assert.equal(h.gate.diagnostics().unresolved_muted_fragments, 0);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.playback(false);
  const snapshot = h.gate.replySnapshot();
  assert.equal(h.gate.deliveredReadback(), actualReadback);
  assert.ok(!JSON.stringify(snapshot).includes("SPECULATIVE"));
  assert.ok(!JSON.stringify(h.gate.diagnostics()).includes("SPECULATIVE"));
  assert.equal(h.gate.isCurrent(snapshot), true);
});

test("a known after-caller muted caption cannot invalidate an already issued current snapshot", () => {
  const h = gateFixture(); h.output(); h.caller(); const snapshot = h.gate.replySnapshot();
  assert.equal(h.muted("I already saved it", 1300, 1500).code, "assistant_not_confirmation");
  assert.equal(h.gate.isCurrent(snapshot), true);
  assert.equal(h.gate.deliveredReadback(), actualReadback);
});

test("possible pre-reply muted text invalidates only once the actual caller ordering is known", () => {
  const h = gateFixture(); h.output();
  assert.equal(h.muted("Unverified scope change", 600, 900).code, "muted_caption_order_pending");
  assert.notEqual(h.gate.snapshot().status, "invalidated");
  assert.equal(h.caller().code, "muted_pre_reply_readback_unverified");
  assert.equal(h.gate.snapshot().status, "invalidated");
  assert.equal(h.gate.deliveredReadback(), null);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.gate.invalidate();
  assert.equal(h.gate.diagnostics().last_invalidation_code, "muted_pre_reply_readback_unverified");
});

test("true caller/readback overlap still fails closed even though earlier noise did not", () => {
  const h = gateFixture(); h.gate.observeSpeech(); h.output(actualReadback, 100, 1000);
  assert.equal(h.caller("Yes", 900, 1100).code, "caller_interrupted_readback");
  assert.equal(h.gate.diagnostics().last_invalidation_code, "caller_interrupted_readback");
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
});

test("late trailing readback revalidates a buffered reply while marks are still pending", () => {
  const h = gateFixture(); h.playback(true); h.output("I will call tomorrow.", 100, 500); h.caller("Yes", 1000, 1200);
  assert.equal(h.gate.snapshot().status, "matched");
  assert.equal(h.output(" At three, should I go ahead?", 800, 1100).code, "caller_interrupted_readback");
  h.playback(false);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
});

test("late pre-caller delivered scope invalidates the older snapshot and remains actual evidence", () => {
  const h = gateFixture(); h.output("I will call tomorrow.", 100, 500); h.caller();
  const previous = h.gate.replySnapshot();
  h.output(" At FOUR. Should I go ahead?", 600, 900);
  assert.equal(h.gate.isCurrent(previous), false); assert.equal(h.gate.consume(previous), null);
  assert.equal(h.gate.deliveredReadback(), "I will call tomorrow. At FOUR. Should I go ahead?");
  // This mismatch is retained for the independent canonical-scope assessor;
  // the gate does not decide that FOUR is equivalent to THREE or approve it.
  assert.equal(h.gate.replySnapshot().history[0].text, "Yes, please go ahead.");
});

test("raw noise preserves evidence while newer captions invalidate the earlier permission snapshot", () => {
  const h = gateFixture(); h.output(); h.caller(); const earlier = h.gate.replySnapshot();
  h.gate.observeSpeech(); assert.equal(h.gate.isCurrent(earlier), true);
  const afterNoise = h.gate.replySnapshot();
  h.caller(" But change the time.", 1250, 1500);
  assert.equal(h.gate.isCurrent(earlier), false); assert.equal(h.gate.consume(earlier), null);
  assert.equal(h.gate.isCurrent(afterNoise), false); assert.equal(h.gate.consume(afterNoise), null);
  assert.equal(h.gate.replySnapshot().history.length, 2);
});

test("muted timing evidence stays bounded and invalidation diagnostics exclude text and identifiers", () => {
  const h = gateFixture(); h.output();
  assert.equal(h.muted("x".repeat(16385), 600, 900).code, "muted_readback_overflow");
  const diagnostics = h.gate.diagnostics();
  assert.equal(diagnostics.last_invalidation_code, "muted_readback_overflow");
  const serialized = JSON.stringify(diagnostics);
  assert.ok(!serialized.includes(binding.callSid)); assert.ok(!serialized.includes(binding.proposalHash));
  assert.ok(!serialized.includes(actualReadback));
});

test("the same proposal gets only one automatic reread, then no-save feedback and ordinary conversation", async () => {
  const messages = [], logs = [], planInputs = [];
  const proposal = { id: randomUUID(), hash: "a".repeat(64), nonce: randomUUID(), summary: "Call tomorrow at three about plants.", operation: "schedule_callback" };
  let assessments = 0;
  const service = {
    async plan(input) { planInputs.push(input); if (planInputs.length === 1) return { kind: "propose", proposal };
      if (planInputs.length <= 3) return { kind: "confirm" };
      return { kind: "reply", reply: "Paris is the capital of France." }; },
    async confirm() { assessments++; throw Error("No valid actual readback was provided"); },
  };
  const conversation = createAssistantConversation({ service, callSid: binding.callSid,
    binding: { call_id: binding.callId, resident_id: binding.residentId },
    commentary: (message) => messages.push(message), thinking() {}, hasPendingPlayback: () => false, quietInput: () => true, logger: (entry) => logs.push(entry) });
  let clock = 0;
  async function caller(text) {
    conversation.speech(); conversation.transcript({ type: "session.input_transcript.delta", event_id: randomUUID(), delta: text, start_ms: clock, end_ms: clock + 100 }); clock += 200;
    conversation.delegate(randomUUID()); await conversation.tick(); for (let n = 0; n < 30; n++) await Promise.resolve();
  }
  await caller("Call tomorrow at three"); await caller("Yes, go ahead"); await caller("Yes, go ahead");
  assert.equal(messages.filter((entry) => entry.startsWith("Read this")).length, 2);
  assert.equal(messages.filter((entry) => entry.includes("has not been saved")).length, 1);
  assert.equal(assessments, 0);
  const limit = logs.find((entry) => entry.event === "assistant_readback_retry_limit");
  assert.equal(limit.attempts, 2); assert.equal(limit.reason, "fresh_reply_unavailable");
  await caller("What is the capital of France?");
  assert.equal(planInputs.at(-1).pending, null);
  assert.ok(messages.at(-1).includes("Paris")); assert.equal(conversation.shouldForwardAudio(), true);
  conversation.close();
});
