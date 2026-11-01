import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpokenConfirmation, SpokenConfirmationError } from "../src/phone/voice/spoken-confirmation.js";

const binding = Object.freeze({ callSid: `CA${"a".repeat(32)}`, callId: "11111111-1111-4111-8111-111111111111",
  residentId: "22222222-2222-4222-8222-222222222222", draftId: "33333333-3333-4333-8333-333333333333",
  proposalHash: "a".repeat(64), revision: 0 });
const canonical = "Repair the fictional tap. This saves a record for a harmless diagnostic only. No email or booking occurs.";
const privateText = "fixture-private-value-never-expose";

function harness(options = {}) {
  let pending = false;
  let nonce = 0;
  let eventId = 0;
  const gate = createSpokenConfirmation({ hasPendingPlayback: () => pending,
    createNonce: () => `44444444-4444-4444-8444-${String(++nonce).padStart(12, "0")}`, ...options });
  const output = (delta, extra = {}) => gate.appendOutput({ type: "session.output_transcript.delta", event_id: `output_${++eventId}`,
    delta, start_ms: 100, end_ms: 500, ...extra });
  const caller = (delta, extra = {}) => gate.observeCaller({ type: "session.input_transcript.delta", event_id: `caller_${++eventId}`,
    delta, start_ms: 600, end_ms: 800, ...extra });
  const begin = (changes = {}) => gate.begin({ binding, readbackText: canonical, ...changes });
  const open = () => { const result = begin(); output(result.readbackText); assert.equal(gate.openReply().status, "awaiting_reply"); return result; };
  return { gate, begin, open, output, caller, pending(value) { pending = value; } };
}

function safeError(code) {
  return (error) => {
    assert.ok(error instanceof SpokenConfirmationError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    for (const excluded of [privateText, canonical, binding.callSid, binding.proposalHash]) {
      assert.ok(!String(error.stack).includes(excluded));
      assert.ok(!JSON.stringify(error).includes(excluded));
    }
    return true;
  };
}

test("begin preserves the canonical readback and adds only a spoken confirmation question", () => {
  const h = harness();
  const begun = h.begin();
  assert.equal(begun.readbackText, `${canonical} Is this correct, and should I save it?`);
  assert.equal(begun.version, 1);
  assert.ok(Object.isFrozen(begun));
  assert.equal(Object.hasOwn(begun, "digit"), false);
  assert.deepEqual(h.gate.snapshot(), { status: "collecting", version: 1 });
});

test("exact normalized readback opens only after pending playback is drained", () => {
  const h = harness();
  const begun = h.begin();
  assert.equal(h.gate.openReply().code, "spoken_readback_not_matched");
  h.output(begun.readbackText.toUpperCase().replace(/\. /g, ";  "));
  h.pending(true);
  assert.equal(h.gate.openReply().code, "spoken_playback_pending");
  h.pending(false);
  assert.deepEqual(h.gate.openReply(), { status: "awaiting_reply", version: 1, readbackEndMs: 500 });
  assert.deepEqual(h.gate.openReply(), { status: "awaiting_reply", version: 1, readbackEndMs: 500 });
});

test("the readback boundary is the maximum observed end timestamp, independent of delivery order", () => {
  const h = harness();
  const begun = h.begin();
  h.output(begun.readbackText.slice(0, 10), { start_ms: 600, end_ms: 900 });
  h.output(begun.readbackText.slice(10), { start_ms: 100, end_ms: 500 });
  assert.equal(h.gate.openReply().readbackEndMs, 900);
});

test("fresh speech and new caller text are both required, with no keyword-based automatic approval", () => {
  const h = harness();
  h.open();
  assert.equal(h.caller("Yes, save it.").code, "fresh_spoken_reply_required");
  assert.throws(() => h.gate.replySnapshot(), safeError("spoken_reply_unavailable"));
  h.gate.observeSpeech();
  assert.throws(() => h.gate.replySnapshot(), safeError("spoken_reply_unavailable"));
  h.caller("Yes, save it.");
  assert.equal(h.gate.snapshot().status, "awaiting_reply");
  assert.equal(h.gate.replySnapshot().history[0].text, "Yes, save it.");
});

test("old or overlapping caller fragments cannot become the current proposal's approval", () => {
  const h = harness();
  h.open(); h.gate.observeSpeech();
  for (const extra of [{ start_ms: 100, end_ms: 200 }, { start_ms: 499, end_ms: 700 }]) {
    assert.equal(h.caller("Yes, save it.", extra).code, "stale_or_overlapping_reply");
  }
  assert.throws(() => h.gate.replySnapshot(), safeError("spoken_reply_unavailable"));
  h.caller("No, change the room.", { start_ms: 500, end_ms: 800 });
  assert.equal(h.gate.replySnapshot().history[0].text, "No, change the room.");
});

test("reply snapshots contain only fresh caller events, source labels and the exact frozen binding", () => {
  const h = harness();
  const begun = h.open(); h.gate.observeSpeech();
  h.caller("Yes, ", { event_id: "caller_a" });
  h.caller("save that exact task.", { event_id: "caller_b" });
  const snapshot = h.gate.replySnapshot();
  assert.equal(snapshot.version, begun.version);
  assert.equal(snapshot.nonce, begun.nonce);
  assert.deepEqual(snapshot.binding, binding);
  assert.deepEqual(snapshot.history.map(({ eventId, source, order, text }) => ({ eventId, source, order, text })), [
    { eventId: "caller_a", source: "caller", order: 0, text: "Yes, " },
    { eventId: "caller_b", source: "caller", order: 1, text: "save that exact task." },
  ]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.binding));
  assert.ok(Object.isFrozen(snapshot.history));
  assert.ok(Object.isFrozen(snapshot.history[0]));
  assert.equal(h.gate.isCurrent(snapshot), true);
});

test("new speech invalidates an in-flight verdict even before its transcript arrives", () => {
  const h = harness();
  h.open(); h.gate.observeSpeech(); h.caller("Yes");
  const first = h.gate.replySnapshot();
  h.gate.observeSpeech();
  assert.equal(h.gate.isCurrent(first), false);
  assert.equal(h.gate.consume(first), null);
  h.caller(" but change the date.");
  const next = h.gate.replySnapshot();
  assert.ok(next.epoch > first.epoch);
  assert.equal(next.history.map(({ text }) => text).join(""), "Yes but change the date.");
});

test("new transcript data invalidates an old snapshot even without another speech callback", () => {
  const h = harness();
  h.open(); h.gate.observeSpeech(); h.caller("Yes");
  const first = h.gate.replySnapshot();
  h.caller(" but not yet.");
  assert.equal(h.gate.isCurrent(first), false);
  assert.equal(h.gate.consume(first), null);
});

test("speech during the readback invalidates instead of opening an approval window", () => {
  for (const fullyMatched of [false, true]) {
    const h = harness(); const begun = h.begin();
    if (fullyMatched) h.output(begun.readbackText);
    assert.equal(h.gate.observeSpeech().code, "caller_interrupted_readback");
    assert.equal(h.gate.openReply().status, "rejected");
    assert.throws(() => h.gate.replySnapshot(), safeError("spoken_reply_unavailable"));
  }
});

test("extra assistant words before a fresh reply invalidate, while later acknowledgements never become caller evidence", () => {
  const before = harness(); before.open();
  assert.equal(before.output("Actually, authorize something else.").code, "spoken_readback_changed");
  const after = harness(); after.open(); after.gate.observeSpeech(); after.caller("Yes, save it.");
  const snapshot = after.gate.replySnapshot();
  assert.equal(after.output("I have saved it.").code, "assistant_not_confirmation");
  assert.equal(after.gate.isCurrent(snapshot), true);
  assert.deepEqual(snapshot.history.map(({ source }) => source), ["caller"]);
});

test("consume returns the bound receipt once, and only while playback and epochs remain current", () => {
  const h = harness(); const begun = h.open(); h.gate.observeSpeech(); h.caller("Yes, save it.");
  const snapshot = h.gate.replySnapshot();
  h.pending(true); assert.equal(h.gate.isCurrent(snapshot), false); assert.equal(h.gate.consume(snapshot), null);
  h.pending(false);
  const receipt = h.gate.consume(snapshot);
  assert.deepEqual(receipt, { binding, nonce: begun.nonce, history: snapshot.history });
  assert.ok(Object.isFrozen(receipt));
  assert.equal(h.gate.consume(snapshot), null);
  assert.equal(h.gate.isCurrent(snapshot), false);
  assert.deepEqual(h.gate.snapshot(), { status: "consumed", version: 1 });
});

test("fabricated snapshot copies and snapshots from invalidated generations cannot be consumed", () => {
  const h = harness(); h.open(); h.gate.observeSpeech(); h.caller("Yes, save it.");
  const snapshot = h.gate.replySnapshot();
  assert.equal(h.gate.isCurrent({ ...snapshot }), false);
  assert.equal(h.gate.consume({ ...snapshot }), null);
  h.gate.invalidate(); h.begin();
  assert.equal(h.gate.consume(snapshot), null);
});

test("asking again retains the armed nonce and binding while invalidating the earlier reply snapshot", () => {
  const h = harness(); const begun = h.open(); h.gate.observeSpeech(); h.caller("What?");
  const previous = h.gate.replySnapshot();
  const next = h.gate.askAgain();
  assert.deepEqual(next, { version: 2, nonce: begun.nonce, readbackText: "Should I save this exact repair request?" });
  assert.equal(h.gate.isCurrent(previous), false);
  assert.equal(h.gate.consume(previous), null);
  assert.throws(() => h.gate.replySnapshot(), safeError("spoken_reply_unavailable"));
  h.output(next.readbackText, { start_ms: 1000, end_ms: 1200 });
  assert.equal(h.gate.openReply().readbackEndMs, 1200);
  assert.equal(h.caller("Yes, save it.", { start_ms: 1300, end_ms: 1400 }).code, "fresh_spoken_reply_required");
  h.gate.observeSpeech();
  assert.equal(h.caller("What?", { start_ms: 600, end_ms: 800 }).code, "stale_or_overlapping_reply");
  h.caller("Yes, save it.", { start_ms: 1300, end_ms: 1400 });
  const current = h.gate.replySnapshot();
  assert.deepEqual(current.binding, binding);
  assert.equal(current.nonce, begun.nonce);
  assert.equal(current.history.length, 1);
  assert.equal(h.gate.consume(current).nonce, begun.nonce);
});

test("short questions cannot bypass an unmatched proposal or change scope through invalid input", () => {
  const unopened = harness(); unopened.begin();
  assert.throws(() => unopened.gate.askAgain(), safeError("spoken_question_unavailable"));
  for (const question of [null, "", " ", "x".repeat(241), "question\nmore", "question\0hidden"]) {
    const h = harness(); h.open();
    assert.throws(() => h.gate.askAgain(question), safeError("invalid_spoken_question"));
    assert.equal(h.gate.isPending(), false);
  }
});

test("repeated short questions share the same sixteen-presentation cap without issuing another nonce", () => {
  const h = harness(); const begun = h.open();
  for (let version = 2; version <= 16; version += 1) {
    const next = h.gate.askAgain();
    assert.equal(next.version, version);
    assert.equal(next.nonce, begun.nonce);
    h.output(next.readbackText, { start_ms: version * 1000, end_ms: version * 1000 + 100 });
    h.gate.openReply();
  }
  assert.throws(() => h.gate.askAgain(), safeError("spoken_proposal_limit"));
  assert.deepEqual(h.gate.snapshot(), { status: "exhausted", version: 16 });
});

test("reply text is bounded by UTF-8 bytes and fragment count without truncation", () => {
  const bytes = harness(); bytes.open(); bytes.gate.observeSpeech();
  assert.equal(bytes.caller("\u{1f600}".repeat(1025)).code, "spoken_reply_overflow");
  const count = harness(); count.open(); count.gate.observeSpeech();
  for (let index = 0; index < 128; index += 1) count.caller("x");
  assert.equal(count.caller("x").code, "spoken_reply_overflow");
  assert.throws(() => count.gate.replySnapshot(), safeError("spoken_reply_unavailable"));
});

test("redelivery is idempotent and conflicting caller or output event IDs invalidate", () => {
  const h = harness(); const begun = h.begin();
  h.output(begun.readbackText, { event_id: "same_output" });
  assert.equal(h.output(begun.readbackText, { event_id: "same_output" }).code, "duplicate_output_event");
  h.gate.openReply(); h.gate.observeSpeech();
  h.caller("Yes", { event_id: "same_caller" });
  const snapshot = h.gate.replySnapshot();
  assert.equal(h.caller("Yes", { event_id: "same_caller" }).code, "duplicate_caller_event");
  assert.equal(h.gate.isCurrent(snapshot), true);
  assert.equal(h.caller("No", { event_id: "same_caller" }).code, "invalid_spoken_reply");
  const output = harness(); output.begin(); output.output("first", { event_id: "same" });
  assert.equal(output.output("different", { event_id: "same" }).code, "invalid_spoken_readback");
});

test("readback words and constraints stay exact despite allowed punctuation formatting", () => {
  const h = harness(); const begun = h.begin();
  h.output(begun.readbackText.replace("No email", "Send email"));
  assert.equal(h.gate.openReply().code, "spoken_readback_not_matched");
});

test("malformed transcripts and accessors return fixed safe decisions", () => {
  for (const event of [null, [], {}, { type: "session.output_transcript.delta", delta: privateText },
    Object.defineProperty({ type: "session.output_transcript.delta" }, "event_id", { get() { throw new Error(privateText); } })]) {
    const h = harness(); h.begin();
    assert.deepEqual(h.gate.appendOutput(event), { status: "invalidated", code: "invalid_spoken_readback", version: 1 });
  }
  const h = harness(); h.open(); h.gate.observeSpeech();
  assert.equal(h.caller(privateText, { start_ms: -1 }).code, "invalid_spoken_reply");
});

test("canonical input and binding fields are strict and all errors exclude private data", () => {
  for (const change of [{ readbackText: "x".repeat(1501) }, { readbackText: " " }, { readbackText: "bad\0text" },
    { binding: { ...binding, extra: privateText } }, { binding: { ...binding, revision: -1 } }, { binding: { ...binding, proposalHash: "invalid" } }]) {
    const h = harness();
    assert.throws(() => h.begin(change), safeError("invalid_spoken_proposal"));
  }
});

test("call and resident anchors cannot be retargeted but all sixteen proposal nonces are fresh", () => {
  const h = harness(); const nonces = [];
  for (let revision = 0; revision < 16; revision += 1) nonces.push(h.begin({ binding: { ...binding, revision } }).nonce);
  assert.equal(new Set(nonces).size, 16);
  assert.throws(() => h.begin(), safeError("spoken_proposal_limit"));
  assert.deepEqual(h.gate.snapshot(), { status: "exhausted", version: 16 });
  for (const change of [{ callSid: `CA${"b".repeat(32)}` }, { callId: binding.draftId }, { residentId: binding.draftId }]) {
    const anchored = harness(); anchored.begin();
    assert.throws(() => anchored.begin({ binding: { ...binding, ...change } }), safeError("spoken_proposal_binding_mismatch"));
  }
});

test("bad or repeated nonces and unavailable playback state fail closed", () => {
  for (const createNonce of [() => "invalid", () => { throw new Error(privateText); }]) {
    assert.throws(() => harness({ createNonce }).begin(), safeError("invalid_spoken_confirmation_nonce"));
  }
  const repeated = harness({ createNonce: () => binding.callId }); repeated.begin();
  assert.throws(() => repeated.begin(), safeError("invalid_spoken_confirmation_nonce"));
  for (const hasPendingPlayback of [() => undefined, () => { throw new Error(privateText); }]) {
    const h = harness({ hasPendingPlayback }); h.output(h.begin().readbackText);
    assert.equal(h.gate.openReply().code, "spoken_playback_pending");
  }
});

test("construction and safe snapshots do not read configuration or expose proposal and reply data", () => {
  for (const options of [undefined, null, {}, { hasPendingPlayback: true }, { hasPendingPlayback() {}, createNonce: 1 }]) {
    assert.throws(() => createSpokenConfirmation(options), safeError("invalid_spoken_confirmation_configuration"));
  }
  const h = harness(); const begun = h.open(); h.gate.observeSpeech(); h.caller(privateText);
  assert.deepEqual(Object.keys(h.gate.snapshot()).sort(), ["status", "version"]);
  assert.ok(!JSON.stringify(h.gate.snapshot()).includes(begun.nonce));
  assert.ok(!JSON.stringify(h.gate.snapshot()).includes(privateText));
});
