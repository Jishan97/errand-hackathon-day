import { randomInt as secureRandomInt, randomUUID } from "node:crypto";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callPattern = /^CA[0-9a-f]{32}$/i;
const bindingKeys = ["callSid", "callId", "residentId", "draftId", "proposalHash", "revision"];
const digitWords = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const maximumOutputBytes = 16 * 1024;
const maximumOutputEvents = 512;

export class ProposalConfirmationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProposalConfirmationError";
    this.code = code;
  }
}

function field(record, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function validText(value) {
  return typeof value === "string" && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function surroundingQuotes(value) {
  let result = value;
  // Allow a quotation wrapper around already-quoted task data. Unpaired or
  // internal identifier quotes remain significant, and excessive nesting fails
  // equality rather than expanding normalization indefinitely.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = result.replace(/(^|[\s([{])["“”]([^"“”]*)["“”](?=$|[\s)\]},.!?;:])/gu, "$1$2");
    if (next === result) break;
    result = next;
  }
  return result;
}

// Preserve words, order and internal punctuation (decimals, contractions and
// identifiers). Sentence separators and surrounding double quotes are speech
// formatting, along with case, whitespace and actual whole digit words. Never
// map homophones or infer semantic equivalence with a model.
export function normalizeReadback(value) {
  return surroundingQuotes(value.normalize("NFC").toLowerCase())
    .replace(/[.,!?;:]+(?=\s|$)/gu, " ")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/gu, (word) => digitWords[word])
    .replace(/\s+/gu, " ").trim();
}

function copyBinding(raw) {
  const keys = Object.keys(raw);
  if (keys.length !== bindingKeys.length || keys.some((key) => !bindingKeys.includes(key))) throw new Error();
  const binding = Object.fromEntries(bindingKeys.map((key) => [key, field(raw, key)]));
  if (typeof binding.callSid !== "string" || !callPattern.test(binding.callSid)) throw new Error();
  for (const key of ["callId", "residentId", "draftId"]) {
    if (typeof binding[key] !== "string" || !uuidPattern.test(binding[key])) throw new Error();
  }
  if (typeof binding.proposalHash !== "string" || !/^[0-9a-f]{64}$/i.test(binding.proposalHash)
    || !Number.isSafeInteger(binding.revision) || binding.revision < 0 || binding.revision > 2_147_483_647) throw new Error();
  return Object.freeze(binding);
}

/**
 * One instance belongs to one authenticated call. This is a human receipt-key
 * gate, not an API playback-completion guarantee. Caller transcript observation
 * is an additional guard; star is the reliable application correction signal.
 * The returned readback/key are for the Live channel only, never logs or errors.
 */
export function createProposalConfirmation(options) {
  let hasPendingPlayback;
  let randomInt;
  let createNonce;
  try {
    hasPendingPlayback = field(options, "hasPendingPlayback");
    const random = Object.getOwnPropertyDescriptor(options, "randomInt");
    const nonce = Object.getOwnPropertyDescriptor(options, "createNonce");
    if ((random && !("value" in random)) || (nonce && !("value" in nonce))) throw new Error();
    randomInt = random?.value ?? secureRandomInt;
    createNonce = nonce?.value ?? randomUUID;
    if ([hasPendingPlayback, randomInt, createNonce].some((value) => typeof value !== "function")) throw new Error();
  } catch {
    throw new ProposalConfirmationError("invalid_confirmation_configuration");
  }

  const usedKeys = new Set();
  const usedNonces = new Set();
  const outputEvents = new Map();
  let anchor;
  let status = "idle";
  let version = 0;
  let current;
  let output = "";
  let outputBytes = 0;

  const decision = (value, code) => Object.freeze({ status: value, ...(code ? { code } : {}), version });
  const isPending = () => status === "collecting" || status === "matched";
  function resetOutput() {
    output = "";
    outputBytes = 0;
    outputEvents.clear();
  }
  function invalidateWith(code) {
    status = "invalidated";
    current = undefined;
    resetOutput();
    return decision("invalidated", code);
  }

  function begin(input) {
    let binding;
    let canonical;
    try {
      binding = copyBinding(field(input, "binding"));
      canonical = field(input, "readbackText");
      if (!validText(canonical) || !canonical.trim() || canonical.length > 1500 || Buffer.byteLength(canonical, "utf8") > 6000) throw new Error();
    } catch {
      invalidateWith("invalid_proposal");
      throw new ProposalConfirmationError("invalid_proposal");
    }
    if (anchor && (anchor.callSid !== binding.callSid || anchor.callId !== binding.callId || anchor.residentId !== binding.residentId)) {
      invalidateWith("proposal_binding_mismatch");
      throw new ProposalConfirmationError("proposal_binding_mismatch");
    }
    const available = ["2", "3", "4", "5", "6", "7", "8", "9"].filter((key) => !usedKeys.has(key));
    if (!available.length) {
      invalidateWith("confirmation_keys_exhausted");
      status = "exhausted";
      throw new ProposalConfirmationError("confirmation_keys_exhausted");
    }
    let digit;
    let nonce;
    try {
      const index = randomInt(0, available.length);
      nonce = createNonce();
      if (!Number.isSafeInteger(index) || index < 0 || index >= available.length || typeof nonce !== "string"
        || !uuidPattern.test(nonce) || usedNonces.has(nonce.toLowerCase())) throw new Error();
      digit = available[index];
    } catch {
      invalidateWith("invalid_confirmation_randomness");
      throw new ProposalConfirmationError("invalid_confirmation_randomness");
    }
    const readbackText = `${canonical} If this is wrong, press star to change it. To save this exact task, press ${digit}.`;
    anchor ??= Object.freeze({ callSid: binding.callSid, callId: binding.callId, residentId: binding.residentId });
    usedKeys.add(digit);
    usedNonces.add(nonce.toLowerCase());
    version += 1;
    current = { binding, nonce, digit, expected: normalizeReadback(readbackText) };
    resetOutput();
    status = "collecting";
    return Object.freeze({ version, nonce, digit, readbackText });
  }

  function appendOutput(event) {
    if (!isPending()) return decision("ignored", "no_pending_proposal");
    let eventId;
    let delta;
    let startMs;
    let endMs;
    try {
      const type = field(event, "type");
      if (typeof type !== "string" || !type) throw new Error();
      if (type !== "session.output_transcript.delta") return decision("ignored", "not_output_transcript");
      eventId = field(event, "event_id");
      delta = field(event, "delta");
      startMs = field(event, "start_ms");
      endMs = field(event, "end_ms");
      if (typeof eventId !== "string" || !eventId || eventId.length > 512 || /[\u0000-\u0020\u007f]/u.test(eventId)
        || !validText(delta) || !delta || !Number.isSafeInteger(startMs) || startMs < 0
        || !Number.isSafeInteger(endMs) || endMs < startMs) throw new Error();
    } catch { return invalidateWith("invalid_output_transcript"); }
    const seen = outputEvents.get(eventId);
    if (seen) {
      if (seen.delta !== delta || seen.startMs !== startMs || seen.endMs !== endMs) return invalidateWith("invalid_output_transcript");
      return decision("ignored", "duplicate_output_event");
    }
    outputBytes += Buffer.byteLength(delta, "utf8");
    if (outputBytes > maximumOutputBytes || outputEvents.size >= maximumOutputEvents) return invalidateWith("readback_overflow");
    outputEvents.set(eventId, { delta, startMs, endMs });
    output += delta;
    const observed = normalizeReadback(output);
    if (status === "matched" && observed !== current.expected) return invalidateWith("readback_changed");
    if (observed === current.expected) status = "matched";
    return decision(status);
  }

  function observeCaller(event) {
    if (!isPending()) return decision("ignored", "no_pending_proposal");
    try {
      if (field(event, "type") !== "session.input_transcript.delta") return decision("ignored", "not_input_transcript");
      const delta = field(event, "delta");
      if (!validText(delta)) return invalidateWith("invalid_caller_transcript");
      if (!delta.trim()) return decision("ignored", "empty_caller_transcript");
      return invalidateWith("caller_content_observed");
    } catch { return invalidateWith("invalid_caller_transcript"); }
  }

  function confirmDigit(digit) {
    if (!isPending()) return decision("rejected", "no_pending_proposal");
    let code;
    if (typeof digit !== "string" || digit !== current.digit) code = "wrong_save_key";
    else if (status !== "matched") code = "readback_not_matched";
    else {
      try { if (hasPendingPlayback() !== false) code = "playback_pending"; }
      catch { code = "playback_state_unavailable"; }
    }
    if (code) {
      invalidateWith(code);
      return decision("rejected", code);
    }
    const result = Object.freeze({ status: "confirmed", binding: current.binding, version, nonce: current.nonce });
    status = "confirmed";
    current = undefined;
    resetOutput();
    return result;
  }

  return Object.freeze({ begin, appendOutput, observeCaller, confirmDigit,
    invalidate: () => invalidateWith("proposal_invalidated"),
    isPending,
    snapshot: () => decision(status),
  });
}
