import assert from "node:assert/strict";
import { test } from "node:test";
import { createIntakeTranscript, IntakeTranscriptError } from "../src/phone/voice/intake-transcript.js";

const callId = "fictional-call-1";

function fragment(delta, number = 1, extra = {}) {
  return {
    type: "session.input_transcript.delta", event_id: `event_${number}`, delta,
    start_ms: number * 100, end_ms: number * 100 + 50, ...extra,
  };
}

function safeError(code) {
  return (error) => {
    assert.ok(error instanceof IntakeTranscriptError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

test("caller fragments form a source-bound draft in arrival order, without a finality or approval claim", () => {
  const intake = createIntakeTranscript({ callId });
  assert.equal(intake.append(fragment("  Inspect the fictional", 2)), true);
  assert.equal(intake.append(fragment(" tap.  ", 1, {
    sourceRefs: [{ type: "call", id: "model-invented-call" }], approval: true,
    private_token: "fixture-secret", client_event_id: "unrelated-client-id",
  })), true);
  assert.deepEqual(intake.freeze(), {
    request: "Inspect the fictional tap.",
    sourceRefs: [{ type: "call", id: callId }],
    transcriptStatus: "application_boundary_not_final",
  });
  const serialized = JSON.stringify(intake.freeze());
  for (const excluded of ["model-invented-call", "fixture-secret", "approval", "event_", "start_ms"]) {
    assert.ok(!serialized.includes(excluded));
  }
});

test("assistant output, DTMF PIN digits, audio and delegation metadata never enter the request", () => {
  const intake = createIntakeTranscript({ callId });
  for (const event of [
    { type: "session.output_transcript.delta", delta: "Assistant claim: approved." },
    { type: "dtmf", digit: "123456" },
    { type: "session.input_audio.append", audio: "fixture-not-an-audio-payload" },
    { type: "session.delegation.created", delegation: { id: "delegation_1", task: "Invented instruction" } },
  ]) assert.equal(intake.append(event), false);
  intake.append(fragment("Inspect the fictional tap."));
  assert.equal(intake.freeze().request, "Inspect the fictional tap.");
});

test("freezing is idempotent and ignores every later event without widening the draft", () => {
  const intake = createIntakeTranscript({ callId });
  intake.append(fragment("A fictional tap repair."));
  const frozen = intake.freeze();
  assert.equal(intake.append(fragment(" Also contact another person.", 2)), false);
  assert.equal(intake.append(null), false);
  assert.equal(intake.freeze(), frozen);
  assert.equal(frozen.request, "A fictional tap repair.");
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.sourceRefs));
  assert.ok(Object.isFrozen(frozen.sourceRefs[0]));
  assert.throws(() => { frozen.sourceRefs[0].id = "other-call"; }, TypeError);
});

test("an identical redelivery is ignored and does not use fragment capacity twice", () => {
  const intake = createIntakeTranscript({ callId, maxFragments: 1 });
  const event = fragment("Tap repair.");
  assert.equal(intake.append(event), true);
  assert.equal(intake.append({ ...event }), false);
  assert.equal(intake.freeze().request, "Tap repair.");
});

test("a reused event ID with changed contents invalidates the entire draft", () => {
  const intake = createIntakeTranscript({ callId });
  intake.append(fragment("Tap repair."));
  assert.throws(() => intake.append(fragment("Different instruction.")), safeError("invalid_transcript_event"));
  assert.throws(() => intake.freeze(), safeError("invalid_transcript_event"));
});

test("the exact request limit is accepted without silently truncating", () => {
  const intake = createIntakeTranscript({ callId });
  intake.append(fragment("x".repeat(2000)));
  assert.equal(intake.freeze().request.length, 2000);
});

test("character overflow invalidates the whole draft rather than saving a truncated request", () => {
  const intake = createIntakeTranscript({ callId, maxChars: 10 });
  intake.append(fragment("Tap repair"));
  assert.throws(() => intake.append(fragment(" extra restriction", 2)), safeError("transcript_overflow"));
  assert.throws(() => intake.append(fragment("new request", 3)), safeError("transcript_overflow"));
  assert.throws(() => intake.freeze(), safeError("transcript_overflow"));
});

test("fragment overflow is bounded independently of request text length", () => {
  const intake = createIntakeTranscript({ callId, maxFragments: 2 });
  intake.append(fragment("a", 1));
  intake.append(fragment("b", 2));
  assert.throws(() => intake.append(fragment("c", 3)), safeError("transcript_overflow"));
  assert.throws(() => intake.freeze(), safeError("transcript_overflow"));
});

test("UTF-16 accounting stays at or below the database character limit", () => {
  const intake = createIntakeTranscript({ callId, maxChars: 2 });
  intake.append(fragment("\u{1f6b0}"));
  assert.equal(intake.freeze().request, "\u{1f6b0}");
});

test("an empty boundary produces no draft and cannot later be populated", () => {
  const intake = createIntakeTranscript({ callId });
  intake.append(fragment(" \t\n "));
  assert.throws(() => intake.freeze(), safeError("empty_transcript"));
  assert.throws(() => intake.append(fragment("Late request.", 2)), safeError("empty_transcript"));
});

test("discarding is irreversible before or after freeze", () => {
  for (const freezeFirst of [false, true]) {
    const intake = createIntakeTranscript({ callId });
    intake.append(fragment("A fictional request."));
    if (freezeFirst) intake.freeze();
    intake.discard();
    assert.equal(intake.append(fragment("Late request.", 2)), false);
    assert.throws(() => intake.freeze(), safeError("intake_discarded"));
  }
});

for (const [description, change] of [
  ["non-string text", { delta: { text: "request" } }],
  ["empty text", { delta: "" }],
  ["control characters", { delta: "request\u0000hidden" }],
  ["missing event ID", { event_id: undefined }],
  ["oversized event ID", { event_id: "e".repeat(513) }],
  ["invalid event ID", { event_id: "event with spaces" }],
  ["fractional timing", { start_ms: 1.5 }],
  ["negative timing", { start_ms: -1 }],
  ["backward interval", { start_ms: 5, end_ms: 4 }],
  ["unsafe timing", { end_ms: Number.MAX_SAFE_INTEGER + 1 }],
]) {
  test(`${description} fails closed with a fixed safe error`, () => {
    const intake = createIntakeTranscript({ callId });
    intake.append(fragment("Earlier draft."));
    assert.throws(() => intake.append(fragment("fixture-private-text", 2, change)), safeError("invalid_transcript_event"));
    assert.throws(() => intake.freeze(), safeError("invalid_transcript_event"));
  });
}

test("malformed records and accessor properties cannot expose raw errors or return prior text", () => {
  for (const event of [null, [], {}, { type: 42 }, { type: "" }, Object.defineProperty(fragment("secret"), "delta", {
    get() { throw new Error("fixture-private-error"); },
  })]) {
    const intake = createIntakeTranscript({ callId });
    intake.append(fragment("Earlier draft."));
    assert.throws(() => intake.append(event), safeError("invalid_transcript_event"));
    assert.throws(() => intake.freeze(), safeError("invalid_transcript_event"));
  }
});

test("invalid configuration cannot bypass request and fragment hard limits or change source binding", () => {
  for (const options of [
    undefined, null, {}, { callId: "" }, { callId: "unsafe call id" }, { callId: 1 },
    { callId, maxChars: 2001 }, { callId, maxChars: 0 }, { callId, maxChars: 1.5 },
    { callId, maxFragments: 257 }, { callId, maxFragments: 0 },
    Object.defineProperty({}, "callId", { get() { throw new Error("fixture-private-config"); } }),
  ]) assert.throws(() => createIntakeTranscript(options), safeError("invalid_intake_configuration"));
});
