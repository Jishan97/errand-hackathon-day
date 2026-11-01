import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpokenConfirmation } from "../src/phone/voice/spoken-confirmation.js";

const binding = Object.freeze({ callSid: `CA${"a".repeat(32)}`, callId: "11111111-1111-4111-8111-111111111111",
  residentId: "22222222-2222-4222-8222-222222222222", draftId: "33333333-3333-4333-8333-333333333333",
  proposalHash: "a".repeat(64), revision: 1 });
const canonical = "Call you on 1 Nov 2026, 3:00 pm (Europe/London) about the fictional plants.";
const paraphrase = "I'll phone you tomorrow, November first, at three in the afternoon London time about the fictional plants. Is that correct, and shall I go ahead?";

function harness(options = {}) {
  let pending = false;
  let nonce = 0;
  let id = 0;
  const gate = createSpokenConfirmation({ readbackMode: "semantic", hasPendingPlayback: () => pending,
    createNonce: () => `44444444-4444-4444-8444-${String(++nonce).padStart(12, "0")}`, ...options });
  return {
    gate, pending(value) { pending = value; },
    begin(changes = {}) { return gate.begin({ binding, readbackText: canonical, confirmationQuestion: "Is this correct, and should I go ahead?", ...changes }); },
    output(delta, changes = {}) { return gate.appendOutput({ type: "session.output_transcript.delta", event_id: `output_${++id}`, delta, start_ms: 100, end_ms: 500, ...changes }); },
    caller(delta, changes = {}) { return gate.observeCaller({ type: "session.input_transcript.delta", event_id: `caller_${++id}`, delta, start_ms: 1000, end_ms: 1200, ...changes }); },
  };
}

function open(h, spoken = paraphrase) {
  h.begin(); h.output(spoken);
  assert.equal(h.gate.openReply().status, "awaiting_reply");
}

test("semantic mode retains actual paraphrased captions without asserting scope or consent", () => {
  const h = harness(); const requested = h.begin();
  assert.equal(h.gate.deliveredReadback(), null);
  h.output(paraphrase);
  assert.notEqual(requested.readbackText, paraphrase);
  assert.equal(h.gate.deliveredReadback(), paraphrase);
  assert.equal(h.gate.openReply().status, "awaiting_reply");
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  assert.equal(h.gate.snapshot().status, "awaiting_reply");
  // The gate does not determine whether this wrong-scope text is acceptable.
  // The separate semantic assessor must reject it before any application write.
  const wrongScope = harness(); open(wrongScope, "I will call next month and send an email. Okay?");
  assert.equal(wrongScope.gate.deliveredReadback(), "I will call next month and send an email. Okay?");
  assert.throws(() => wrongScope.gate.replySnapshot(), /spoken_reply_unavailable/);
});

test("literal mode remains the default and still requires exact normalized wording", () => {
  const literal = harness({ readbackMode: "literal" }); literal.begin(); literal.output(paraphrase);
  assert.equal(literal.gate.openReply().code, "spoken_readback_not_matched");
  assert.equal(literal.gate.deliveredReadback(), null);
  const defaultMode = harness({ readbackMode: undefined });
  const requested = defaultMode.begin(); defaultMode.output(requested.readbackText);
  assert.equal(defaultMode.gate.openReply().status, "awaiting_reply");
  assert.equal(defaultMode.gate.deliveredReadback(), requested.readbackText);
});

test("semantic mode requires caption text, tracked playback drain and a new spoken reply", () => {
  const h = harness(); h.begin();
  assert.equal(h.gate.openReply().code, "spoken_readback_not_matched");
  h.output("  ");
  assert.equal(h.gate.openReply().code, "spoken_readback_not_matched");
  h.output(paraphrase); h.pending(true);
  assert.equal(h.gate.deliveredReadback(), null);
  assert.equal(h.gate.openReply().code, "spoken_playback_pending");
  h.pending(false); assert.equal(h.gate.openReply().status, "awaiting_reply");
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.gate.observeSpeech();
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.caller("Yes, please go ahead.");
  const snapshot = h.gate.replySnapshot();
  assert.equal(h.gate.isCurrent(snapshot), true);
  h.pending(true); assert.equal(h.gate.isCurrent(snapshot), false);
  assert.equal(h.gate.consume(snapshot), null);
});

test("actual post-readback caller captions can establish reply freshness without an RMS prerequisite", () => {
  const h = harness(); open(h);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.caller("Yes, please go ahead.");
  const snapshot = h.gate.replySnapshot();
  assert.equal(h.gate.isCurrent(snapshot), true);
  assert.deepEqual(snapshot.history.map((entry) => entry.text), ["Yes, please go ahead."]);
  // This is eligible evidence for the separate assessor, not a semantic verdict.
  assert.equal(h.gate.deliveredReadback(), paraphrase);
});

test("pre-reply fragments extend semantic readback and move the timestamp boundary", () => {
  const h = harness(); h.begin(); h.output("I will call tomorrow."); h.gate.openReply();
  h.pending(true);
  h.output(" At three in London time. Shall I go ahead?", { start_ms: 500, end_ms: 900 });
  assert.equal(h.gate.deliveredReadback(), null);
  h.pending(false);
  assert.equal(h.gate.openReply().readbackEndMs, 900);
  assert.equal(h.gate.deliveredReadback(), "I will call tomorrow. At three in London time. Shall I go ahead?");
  h.gate.observeSpeech();
  assert.equal(h.caller("An old fragment", { start_ms: 800, end_ms: 899 }).code, "stale_or_overlapping_reply");
  h.caller("Yes", { start_ms: 900, end_ms: 1100 });
  assert.equal(h.gate.replySnapshot().history.length, 1);
});

test("a caller caption crossing the readback boundary invalidates rather than creating partial consent", () => {
  const h = harness(); open(h); h.gate.observeSpeech();
  assert.equal(h.caller("Yes", { start_ms: 499, end_ms: 700 }).code, "caller_interrupted_readback");
  h.caller(" please go ahead", { start_ms: 800, end_ms: 1000 });
  assert.equal(h.gate.deliveredReadback(), null);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
});

test("late pre-reply captions invalidate an issued snapshot and actual-text assessment", () => {
  const h = harness(); open(h, "Call tomorrow.");
  h.gate.observeSpeech(); h.caller("Yes", { start_ms: 1100, end_ms: 1200 });
  const first = h.gate.replySnapshot();
  h.output(" At three. May I go ahead?", { start_ms: 600, end_ms: 900 });
  assert.equal(h.gate.isCurrent(first), false);
  assert.equal(h.gate.consume(first), null);
  const latest = h.gate.replySnapshot();
  assert.ok(latest.epoch > first.epoch);
  assert.equal(h.gate.deliveredReadback(), "Call tomorrow. At three. May I go ahead?");
  assert.equal(h.gate.isCurrent(latest), true);
});

test("after-caller assistant additions never enter delivered readback or caller evidence", () => {
  const h = harness(); open(h); h.gate.observeSpeech(); h.caller("Yes");
  const snapshot = h.gate.replySnapshot();
  assert.equal(h.output("Done, I saved it.", { start_ms: 1100, end_ms: 1400 }).code, "assistant_not_confirmation");
  assert.equal(h.gate.deliveredReadback(), paraphrase);
  assert.equal(h.gate.isCurrent(snapshot), true);
  assert.deepEqual(snapshot.history.map((entry) => entry.source), ["caller"]);
});

test("semantic RMS activity during pending playback preserves readback but cannot supply permission", () => {
  const playback = harness(); playback.begin(); playback.pending(true); playback.output(paraphrase);
  playback.gate.observeSpeech();
  assert.notEqual(playback.gate.snapshot().status, "invalidated");
  assert.equal(playback.gate.deliveredReadback(), null);
  assert.throws(() => playback.gate.replySnapshot(), /spoken_reply_unavailable/);
  playback.pending(false);
  assert.equal(playback.gate.openReply().status, "awaiting_reply");
  assert.equal(playback.gate.deliveredReadback(), paraphrase);
  // Draining marks and observing audio energy still provide no caller text or
  // independent semantic decision, so noise alone cannot authorize a save.
  assert.throws(() => playback.gate.replySnapshot(), /spoken_reply_unavailable/);
});

test("post-readback caller text can wait for lagging playback acknowledgment without early approval", () => {
  const h = harness(); h.begin(); h.pending(true); h.output(paraphrase);
  h.gate.observeSpeech(); h.caller("Yes, please go ahead.");
  assert.notEqual(h.gate.snapshot().status, "invalidated");
  assert.equal(h.gate.deliveredReadback(), null);
  assert.throws(() => h.gate.replySnapshot(), /spoken_reply_unavailable/);
  h.pending(false);
  assert.equal(h.gate.openReply().status, "awaiting_reply");
  const snapshot = h.gate.replySnapshot();
  assert.deepEqual(snapshot.history.map((entry) => entry.text), ["Yes, please go ahead."]);
  assert.equal(h.gate.isCurrent(snapshot), true);
  assert.equal(h.gate.deliveredReadback(), paraphrase);
});

test("true overlapping late captions still invalidate the semantic reply and cannot consume permission", () => {
  const overlap = harness(); open(overlap); overlap.gate.observeSpeech(); overlap.caller("Yes");
  const prior = overlap.gate.replySnapshot();
  assert.equal(overlap.output("More action scope", { start_ms: 900, end_ms: 1100 }).code, "caller_interrupted_readback");
  assert.equal(overlap.gate.consume(prior), null);
  assert.equal(overlap.gate.deliveredReadback(), null);
});

test("semantic snapshots preserve binding through raw activity but reject new caller text and replay", () => {
  const h = harness(); const requested = h.begin(); h.output(paraphrase); h.gate.openReply();
  h.gate.observeSpeech(); h.caller("Yes");
  const first = h.gate.replySnapshot();
  assert.equal(first.nonce, requested.nonce);
  assert.deepEqual(first.binding, binding);
  assert.ok(Object.isFrozen(first.binding));
  assert.equal(h.gate.consume({ ...first }), null);
  h.gate.observeSpeech();
  assert.equal(h.gate.isCurrent(first), true);
  h.caller(" please.");
  assert.equal(h.gate.consume(first), null);
  const current = h.gate.replySnapshot();
  const receipt = h.gate.consume(current);
  assert.deepEqual(receipt.binding, binding); assert.equal(receipt.nonce, requested.nonce);
  assert.equal(h.gate.consume(current), null);
  assert.equal(h.gate.deliveredReadback(), null);
});

test("semantic mode retains output/reply bounds, duplicate guards and configuration validation", () => {
  for (const mode of ["anything", null, 1, {}]) assert.throws(() => harness({ readbackMode: mode }), /invalid_spoken_confirmation_configuration/);
  const output = harness(); output.begin();
  output.output("A", { event_id: "same" });
  assert.equal(output.output("A", { event_id: "same" }).code, "duplicate_output_event");
  assert.equal(output.output("B", { event_id: "same" }).code, "invalid_spoken_readback");
  const oversized = harness(); oversized.begin();
  assert.equal(oversized.output("x".repeat(16385)).code, "spoken_readback_overflow");
  const reply = harness(); open(reply); reply.gate.observeSpeech();
  assert.equal(reply.caller("x".repeat(4097)).code, "spoken_reply_overflow");
});
