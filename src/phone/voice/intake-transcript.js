const maximumRequestChars = 2000;
const maximumFragments = 256;
const maximumEventIdChars = 512;

export class IntakeTranscriptError extends Error {
  constructor(code) {
    super(code);
    this.name = "IntakeTranscriptError";
    this.code = code;
  }
}

function field(record, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new IntakeTranscriptError("invalid_transcript_event");
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new IntakeTranscriptError("invalid_transcript_event");
  }
  return descriptor.value;
}

/**
 * Collect caller fragments only after application identity verification has
 * finished. PIN collection belongs before this accumulator and before Live input.
 * Live has no final-transcript event: freeze() is an application boundary that
 * creates a draft for exact readback, never evidence of approval or completeness.
 */
export function createIntakeTranscript(options) {
  let callId;
  let maxChars;
  let maxFragments;
  try {
    callId = field(options, "callId");
    const chars = Object.getOwnPropertyDescriptor(options, "maxChars");
    const fragments = Object.getOwnPropertyDescriptor(options, "maxFragments");
    if ((chars && !("value" in chars)) || (fragments && !("value" in fragments))) throw new Error();
    maxChars = chars?.value ?? maximumRequestChars;
    maxFragments = fragments?.value ?? maximumFragments;
    if (
      typeof callId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(callId) ||
      !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > maximumRequestChars ||
      !Number.isSafeInteger(maxFragments) || maxFragments < 1 || maxFragments > maximumFragments
    ) throw new Error();
  } catch {
    throw new IntakeTranscriptError("invalid_intake_configuration");
  }

  let state = "collecting";
  let text = "";
  let failureCode;
  let frozen;
  const events = new Map();

  function fail(code) {
    state = "failed";
    failureCode = code;
    text = "";
    events.clear();
    throw new IntakeTranscriptError(code);
  }

  function append(event) {
    if (state === "frozen" || state === "discarded") return false;
    if (state === "failed") throw new IntakeTranscriptError(failureCode);

    let type;
    let eventId;
    let delta;
    let startMs;
    let endMs;
    try {
      type = field(event, "type");
      if (typeof type !== "string" || !type) throw new Error();
      // Assistant captions, DTMF, audio and delegation metadata are never intake.
      if (type !== "session.input_transcript.delta") return false;
      eventId = field(event, "event_id");
      delta = field(event, "delta");
      startMs = field(event, "start_ms");
      endMs = field(event, "end_ms");
      if (
        typeof eventId !== "string" || !eventId || eventId.length > maximumEventIdChars ||
        /[\u0000-\u0020\u007f]/u.test(eventId) ||
        typeof delta !== "string" || !delta || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(delta) ||
        !Number.isSafeInteger(startMs) || startMs < 0 ||
        !Number.isSafeInteger(endMs) || endMs < startMs
      ) throw new Error();
    } catch {
      return fail("invalid_transcript_event");
    }

    const existing = events.get(eventId);
    if (existing) {
      if (existing.delta !== delta || existing.startMs !== startMs || existing.endMs !== endMs) {
        return fail("invalid_transcript_event");
      }
      return false;
    }
    // UTF-16 length is conservative for the database's 2000-character limit.
    if (text.length + delta.length > maxChars || events.size >= maxFragments) {
      return fail("transcript_overflow");
    }
    events.set(eventId, { delta, startMs, endMs });
    text += delta;
    return true;
  }

  function freeze() {
    if (state === "discarded") throw new IntakeTranscriptError("intake_discarded");
    if (state === "failed") throw new IntakeTranscriptError(failureCode);
    if (state === "frozen") return frozen;
    const request = text.trim();
    if (!request) return fail("empty_transcript");
    frozen = Object.freeze({
      request,
      sourceRefs: Object.freeze([Object.freeze({ type: "call", id: callId })]),
      transcriptStatus: "application_boundary_not_final",
    });
    state = "frozen";
    text = "";
    events.clear();
    return frozen;
  }

  function discard() {
    state = "discarded";
    text = "";
    events.clear();
    frozen = undefined;
  }

  return Object.freeze({ append, freeze, discard });
}
