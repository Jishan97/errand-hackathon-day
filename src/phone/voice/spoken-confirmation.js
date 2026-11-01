import { randomUUID } from "node:crypto";
import { normalizeReadback } from "./proposal-confirmation.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bindingKeys = ["callSid", "callId", "residentId", "draftId", "proposalHash", "revision"];

export class SpokenConfirmationError extends Error {
  constructor(code) { super(code); this.name = "SpokenConfirmationError"; this.code = code; }
}

function field(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function text(value) {
  return typeof value === "string" && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function copyBinding(value) {
  const keys = Object.keys(value);
  if (keys.length !== bindingKeys.length || keys.some((key) => !bindingKeys.includes(key))) throw new Error();
  const result = Object.fromEntries(bindingKeys.map((key) => [key, field(value, key)]));
  if (typeof result.callSid !== "string" || !/^CA[0-9a-f]{32}$/i.test(result.callSid)) throw new Error();
  for (const key of ["callId", "residentId", "draftId"]) {
    if (typeof result[key] !== "string" || !uuidPattern.test(result[key])) throw new Error();
  }
  if (typeof result.proposalHash !== "string" || !/^[0-9a-f]{64}$/i.test(result.proposalHash)
    || !Number.isSafeInteger(result.revision) || result.revision < 0 || result.revision > 2_147_483_647) throw new Error();
  return Object.freeze(result);
}

function transcript(event, type) {
  if (field(event, "type") !== type) return null;
  const id = field(event, "event_id");
  const delta = field(event, "delta");
  const startMs = field(event, "start_ms");
  const endMs = field(event, "end_ms");
  if (typeof id !== "string" || !id || id.length > 512 || /[\u0000-\u0020\u007f]/u.test(id)
    || !text(delta) || !delta || !Number.isSafeInteger(startMs) || startMs < 0
    || !Number.isSafeInteger(endMs) || endMs < startMs) throw new Error();
  return { id, delta, startMs, endMs };
}

function sameEvent(first, next) {
  return first.delta === next.delta && first.startMs === next.startMs && first.endMs === next.endMs;
}

/**
 * A bounded proposal/reply gate, not a speech-finality or semantic-approval API.
 * The bridge supplies fresh PCMU speech activity and its quiet/settle policy.
 * A separate Sol verdict must approve the exact reply snapshot before consume().
 */
export function createSpokenConfirmation(options) {
  let hasPendingPlayback;
  let createNonce;
  let readbackMode;
  try {
    hasPendingPlayback = field(options, "hasPendingPlayback");
    const nonce = Object.getOwnPropertyDescriptor(options, "createNonce");
    if (nonce && !("value" in nonce)) throw new Error();
    createNonce = nonce?.value ?? randomUUID;
    const mode = Object.getOwnPropertyDescriptor(options, "readbackMode");
    if (mode && !("value" in mode)) throw new Error();
    readbackMode = mode?.value === undefined ? "literal" : mode.value;
    if (typeof hasPendingPlayback !== "function" || typeof createNonce !== "function") throw new Error();
    if (!["literal", "semantic"].includes(readbackMode)) throw new Error();
  } catch { throw new SpokenConfirmationError("invalid_spoken_confirmation_configuration"); }

  const usedNonces = new Set();
  const issuedSnapshots = new WeakSet();
  const assessmentSnapshots = new WeakSet();
  const outputEvents = new Map();
  const callerEvents = new Map();
  const mutedOutputRanges = new Map();
  let anchor;
  let current;
  let status = "idle";
  let version = 0;
  let epoch = 0;
  let output = "";
  let outputBytes = 0;
  let callerBytes = 0;
  let readbackEndMs = 0;
  let freshSpeech = false;
  let mutedOutputBytes = 0;
  let lastInvalidationCode = null;

  const decision = (state, code) => Object.freeze({ status: state, ...(code ? { code } : {}), version });
  const isPending = () => ["collecting", "matched", "awaiting_reply"].includes(status);
  function clearBuffers() {
    outputEvents.clear(); callerEvents.clear(); mutedOutputRanges.clear();
    output = ""; outputBytes = 0; callerBytes = 0; readbackEndMs = 0; freshSpeech = false;
    mutedOutputBytes = 0;
  }
  function invalidateWith(code) {
    if (status !== "invalidated") lastInvalidationCode = code;
    status = "invalidated"; current = undefined; epoch += 1; clearBuffers();
    return decision("invalidated", code);
  }
  function playbackClear() {
    try { return hasPendingPlayback() === false; }
    catch { return false; }
  }
  const eligibleCallers = () => [...callerEvents.values()].filter((entry) => entry.startMs >= readbackEndMs);
  function reconcileMutedOutput() {
    if (!mutedOutputRanges.size) return null;
    if (!output.trim()) return decision(status, "muted_caption_order_pending");
    const replyStartMs = Math.min(...eligibleCallers().map((entry) => entry.startMs));
    if (!Number.isFinite(replyStartMs)) return decision(status, "muted_caption_order_pending");
    for (const range of mutedOutputRanges.values()) {
      if (range.startMs < replyStartMs) return invalidateWith("muted_pre_reply_readback_unverified");
    }
    // These intervals are proven after-caller output. Their text was never
    // retained and cannot become readback or caller evidence.
    mutedOutputRanges.clear();
    return null;
  }

  function begin(input) {
    let binding;
    let canonical;
    let question;
    try {
      binding = copyBinding(field(input, "binding"));
      canonical = field(input, "readbackText");
      question = Object.hasOwn(input, "confirmationQuestion") ? field(input, "confirmationQuestion") : "Is this correct, and should I save it?";
      if (!text(question) || !question.trim() || question.length > 240 || /[\r\n\t]/u.test(question)) throw new Error();
      if (!text(canonical) || !canonical.trim() || canonical.length > 1500 || Buffer.byteLength(canonical, "utf8") > 6000) throw new Error();
    } catch {
      invalidateWith("invalid_spoken_proposal");
      throw new SpokenConfirmationError("invalid_spoken_proposal");
    }
    if (anchor && ["callSid", "callId", "residentId"].some((key) => anchor[key] !== binding[key])) {
      invalidateWith("spoken_proposal_binding_mismatch");
      throw new SpokenConfirmationError("spoken_proposal_binding_mismatch");
    }
    if (version >= 16) {
      invalidateWith("spoken_proposal_limit"); status = "exhausted";
      throw new SpokenConfirmationError("spoken_proposal_limit");
    }
    let nonce;
    try {
      nonce = createNonce();
      if (typeof nonce !== "string" || !uuidPattern.test(nonce) || usedNonces.has(nonce.toLowerCase())) throw new Error();
    } catch {
      invalidateWith("invalid_spoken_confirmation_nonce");
      throw new SpokenConfirmationError("invalid_spoken_confirmation_nonce");
    }
    const readbackText = `${canonical} ${question}`;
    anchor ??= Object.freeze({ callSid: binding.callSid, callId: binding.callId, residentId: binding.residentId });
    usedNonces.add(nonce.toLowerCase());
    version += 1; epoch += 1; clearBuffers();
    lastInvalidationCode = null;
    current = { binding, nonce, expected: normalizeReadback(readbackText) };
    status = "collecting";
    return Object.freeze({ version, nonce, readbackText });
  }

  function askAgain(questionText = "Should I save this exact repair request?") {
    if (status !== "awaiting_reply" || !current) throw new SpokenConfirmationError("spoken_question_unavailable");
    if (!text(questionText) || !questionText.trim() || questionText.length > 240 || /[\r\n\t]/u.test(questionText)) {
      invalidateWith("invalid_spoken_question");
      throw new SpokenConfirmationError("invalid_spoken_question");
    }
    if (version >= 16) {
      invalidateWith("spoken_proposal_limit"); status = "exhausted";
      throw new SpokenConfirmationError("spoken_proposal_limit");
    }
    const { binding, nonce } = current;
    version += 1; epoch += 1; clearBuffers();
    lastInvalidationCode = null;
    current = { binding, nonce, expected: normalizeReadback(questionText) };
    status = "collecting";
    return Object.freeze({ version, nonce, readbackText: questionText });
  }

  function appendOutput(event) {
    if (!isPending()) return decision("ignored", "no_pending_spoken_proposal");
    // An assistant acknowledgement after the caller starts cannot authorize or
    // alter the frozen proposal and is never part of the caller reply history.
    if (readbackMode === "literal" && status === "awaiting_reply" && freshSpeech) return decision("ignored", "assistant_not_confirmation");
    let item;
    try { item = transcript(event, "session.output_transcript.delta"); }
    catch { return invalidateWith("invalid_spoken_readback"); }
    if (!item) return decision("ignored", "not_output_transcript");
    const previous = outputEvents.get(item.id);
    if (previous) {
      if (!sameEvent(previous, item)) return invalidateWith("invalid_spoken_readback");
      return decision("ignored", "duplicate_output_event");
    }
    if (readbackMode === "semantic" && mutedOutputRanges.has(item.id)) return decision("ignored", "muted_output_not_delivered");
    if (readbackMode === "semantic" && !output.trim() && item.delta.trim()) {
      // Before the first delivered readback caption, caller fragments are only
      // provisional: they may be a late old request or the later yes. Establish
      // the actual output interval before classifying them as reply evidence.
      if ([...callerEvents.values()].some((entry) => entry.startMs < item.endMs && entry.endMs > item.startMs)) {
        return invalidateWith("caller_interrupted_readback");
      }
    } else if (readbackMode === "semantic" && output.trim() && freshSpeech) {
      // Captions can arrive late. Retain a newly delivered pre-reply fragment,
      // but never let an assistant acknowledgement after the caller started
      // extend what is assessed as the readback. Unknown ordering fails closed.
      const callerStartMs = Math.min(...eligibleCallers().map((entry) => entry.startMs));
      if (Number.isFinite(callerStartMs)) {
        if (item.startMs >= callerStartMs) return decision("ignored", "assistant_not_confirmation");
        if (item.endMs > callerStartMs) return invalidateWith("caller_interrupted_readback");
      }
    }
    if (outputEvents.size >= 512 || outputBytes + Buffer.byteLength(item.delta, "utf8") > 16 * 1024) return invalidateWith("spoken_readback_overflow");
    if (readbackMode === "literal" && status === "awaiting_reply") {
      if (normalizeReadback(item.delta)) return invalidateWith("spoken_readback_changed");
      return decision("ignored", "empty_output_transcript");
    }
    outputEvents.set(item.id, item);
    outputBytes += Buffer.byteLength(item.delta, "utf8");
    output += item.delta;
    readbackEndMs = Math.max(readbackEndMs, item.endMs);
    if (readbackMode === "semantic") {
      // This marks only a caption candidate, not a semantic match or approval.
      // The independent assessor must compare the actual delivered text with
      // the canonical action, including time/scope and the direct question.
      epoch += 1;
      if (status !== "awaiting_reply") status = output.trim() ? "matched" : "collecting";
      const unresolved = reconcileMutedOutput();
      if (unresolved) return unresolved;
      return decision(status);
    }
    const observed = normalizeReadback(output);
    if (status === "matched" && observed !== current.expected) return invalidateWith("spoken_readback_changed");
    if (observed === current.expected) status = "matched";
    return decision(status);
  }

  function openReply() {
    if (readbackMode === "semantic") {
      if (!isPending() || !output.trim()) return decision("rejected", "spoken_readback_not_matched");
      const unresolved = reconcileMutedOutput();
      if (unresolved) return unresolved;
      if (!playbackClear()) return decision("rejected", "spoken_playback_pending");
      status = "awaiting_reply";
      return Object.freeze({ status, version, readbackEndMs });
    }
    if (status === "awaiting_reply") return Object.freeze({ status, version, readbackEndMs });
    if (status !== "matched") return decision("rejected", "spoken_readback_not_matched");
    if (!playbackClear()) return decision("rejected", "spoken_playback_pending");
    status = "awaiting_reply";
    return Object.freeze({ status, version, readbackEndMs });
  }

  function observeSpeech() {
    if (!isPending()) return decision("ignored", "no_pending_spoken_proposal");
    if (readbackMode === "semantic") {
      // Raw activity can be breath, background noise or a marker arriving late.
      // The bridge uses it to postpone commitment until input is quiet. It is
      // not new semantic evidence and must not invalidate an unchanged caption
      // snapshot or repeatedly cancel its read-only assessment.
      freshSpeech = true;
      return decision(status);
    }
    if (status !== "awaiting_reply") return invalidateWith("caller_interrupted_readback");
    freshSpeech = true; epoch += 1;
    return decision(status);
  }

  function observeCaller(event) {
    if (readbackMode === "semantic" ? !isPending() : status !== "awaiting_reply" || !freshSpeech) return decision("ignored", "fresh_spoken_reply_required");
    let item;
    try { item = transcript(event, "session.input_transcript.delta"); }
    catch { return invalidateWith("invalid_spoken_reply"); }
    if (!item) return decision("ignored", "not_input_transcript");
    if (item.startMs < readbackEndMs) {
      if (readbackMode === "semantic" && item.endMs > readbackEndMs) return invalidateWith("caller_interrupted_readback");
      return decision("ignored", "stale_or_overlapping_reply");
    }
    const previous = callerEvents.get(item.id);
    if (previous) {
      if (!sameEvent(previous, item)) return invalidateWith("invalid_spoken_reply");
      return decision("ignored", "duplicate_caller_event");
    }
    if (callerEvents.size >= 128 || callerBytes + Buffer.byteLength(item.delta, "utf8") > 4096) return invalidateWith("spoken_reply_overflow");
    callerEvents.set(item.id, item); callerBytes += Buffer.byteLength(item.delta, "utf8"); epoch += 1;
    if (readbackMode === "semantic") {
      freshSpeech = true;
      const unresolved = reconcileMutedOutput();
      if (unresolved) return unresolved;
    }
    return decision(status);
  }

  function observeMutedOutput(event) {
    if (readbackMode !== "semantic" || !isPending()) return decision("ignored", "no_pending_spoken_proposal");
    let item;
    try { item = transcript(event, "session.output_transcript.delta"); }
    catch { return invalidateWith("invalid_muted_output_interval"); }
    if (!item) return decision("ignored", "not_output_transcript");
    const delivered = outputEvents.get(item.id);
    if (delivered) {
      if (!sameEvent(delivered, item)) return invalidateWith("invalid_muted_output_interval");
      return decision("ignored", "duplicate_output_event");
    }
    const previous = mutedOutputRanges.get(item.id);
    if (previous) {
      if (previous.startMs !== item.startMs || previous.endMs !== item.endMs) return invalidateWith("invalid_muted_output_interval");
      return decision("ignored", "duplicate_muted_interval");
    }
    const replyStartMs = output.trim() ? Math.min(...eligibleCallers().map((entry) => entry.startMs)) : Infinity;
    if (Number.isFinite(replyStartMs)) {
      if (item.startMs >= replyStartMs) return decision("ignored", "assistant_not_confirmation");
      return invalidateWith("muted_pre_reply_readback_unverified");
    }
    const bytes = Buffer.byteLength(item.delta, "utf8");
    if (mutedOutputRanges.size >= 512 || mutedOutputBytes + bytes > 16 * 1024) return invalidateWith("muted_readback_overflow");
    // Do not retain speculative text. Only bounded interval metadata is needed
    // to decide whether a late caption could alter the pre-reply presentation.
    mutedOutputRanges.set(item.id, { startMs: item.startMs, endMs: item.endMs });
    mutedOutputBytes += bytes; epoch += 1;
    return reconcileMutedOutput() ?? decision(status);
  }

  function replySnapshot() {
    if (readbackMode === "semantic") openReply();
    const candidates = readbackMode === "semantic" ? eligibleCallers() : [...callerEvents.values()];
    if (status !== "awaiting_reply" || !freshSpeech || !candidates.some((event) => event.delta.trim())
      || (readbackMode === "semantic" && (!output.trim() || !playbackClear() || mutedOutputRanges.size))) {
      throw new SpokenConfirmationError("spoken_reply_unavailable");
    }
    const history = Object.freeze(candidates.map((event, order) => Object.freeze({
      eventId: event.id, source: "caller", order, startMs: event.startMs, endMs: event.endMs, text: event.delta,
    })));
    const snapshot = Object.freeze({ version, epoch, nonce: current.nonce, binding: current.binding, history });
    issuedSnapshots.add(snapshot);
    return snapshot;
  }

  // Read-only semantic work may inspect current caption evidence while the
  // physical playback acknowledgment is still pending. This is not permission
  // to consume: the strict isCurrent()/consume() boundary remains unchanged.
  function assessmentSnapshot() {
    if (readbackMode !== "semantic") return replySnapshot();
    const unresolved = reconcileMutedOutput();
    const candidates = eligibleCallers();
    if (unresolved || !["matched", "awaiting_reply"].includes(status) || !current || !output.trim() ||
      !candidates.some((entry) => entry.delta.trim()) || mutedOutputRanges.size) {
      throw new SpokenConfirmationError("spoken_reply_unavailable");
    }
    const history = Object.freeze(candidates.map((entry, order) => Object.freeze({
      eventId: entry.id, source: "caller", order, startMs: entry.startMs, endMs: entry.endMs, text: entry.delta,
    })));
    const snapshot = Object.freeze({ version, epoch, nonce: current.nonce, binding: current.binding, history });
    issuedSnapshots.add(snapshot); assessmentSnapshots.add(snapshot);
    return snapshot;
  }

  function isEvidenceCurrent(snapshot) {
    try {
      return (status === "awaiting_reply" || (readbackMode === "semantic" && status === "matched" && assessmentSnapshots.has(snapshot)))
        && issuedSnapshots.has(snapshot) && snapshot.version === version && snapshot.epoch === epoch
        && snapshot.nonce === current.nonce && snapshot.binding === current.binding
        && (readbackMode !== "semantic" || (output.trim().length > 0 && mutedOutputRanges.size === 0));
    } catch { return false; }
  }

  function isCurrent(snapshot) {
    return status === "awaiting_reply" && isEvidenceCurrent(snapshot) && playbackClear();
  }

  function consume(snapshot) {
    if (!isCurrent(snapshot)) return null;
    const receipt = Object.freeze({ binding: current.binding, nonce: current.nonce, history: snapshot.history });
    status = "consumed"; current = undefined; epoch += 1; clearBuffers();
    return receipt;
  }

  // Actual caption text, never the requested/canonical wording. The caller must
  // still supply a fresh reply and an independent semantic verdict must pass.
  function deliveredReadback() {
    return isPending() && ["matched", "awaiting_reply"].includes(status) && output.trim() && playbackClear()
      && (readbackMode !== "semantic" || mutedOutputRanges.size === 0) ? output : null;
  }

  function readbackForAssessment() {
    if (readbackMode !== "semantic") return deliveredReadback();
    return isPending() && ["matched", "awaiting_reply"].includes(status) && output.trim() && mutedOutputRanges.size === 0 ? output : null;
  }

  return Object.freeze({ begin, askAgain, appendOutput, openReply, observeSpeech, observeCaller, replySnapshot, assessmentSnapshot, isCurrent, isEvidenceCurrent, consume, deliveredReadback, readbackForAssessment, observeMutedOutput,
    invalidate: () => invalidateWith("spoken_proposal_invalidated"),
    snapshot: () => decision(status), isPending,
    diagnostics: () => Object.freeze({ status, version, last_invalidation_code: lastInvalidationCode,
      readback_fragments: outputEvents.size, candidate_reply_fragments: callerEvents.size, unresolved_muted_fragments: mutedOutputRanges.size }),
  });
}
