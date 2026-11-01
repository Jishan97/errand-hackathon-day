// Temporary post-PIN conversation data. Never log or persist raw fragments.
export function createRepairHistory() {
  const events = new Map();
  let chars = 0;
  let discarded = false;
  return Object.freeze({
    append(event) {
      if (discarded) throw new Error("repair_history_discarded");
      const source = event.type === "session.input_transcript.delta" ? "caller"
        : event.type === "session.output_transcript.delta" ? "assistant" : null;
      if (!source) return false;
      if (typeof event.event_id !== "string" || !event.event_id || event.event_id.length > 512 ||
        /[\u0000-\u0020\u007f]/u.test(event.event_id) || typeof event.delta !== "string" || !event.delta ||
        event.delta.length > 2000 || !event.delta.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(event.delta) ||
        !Number.isSafeInteger(event.start_ms) || event.start_ms < 0 ||
        !Number.isSafeInteger(event.end_ms) || event.end_ms < event.start_ms) throw new Error("invalid_repair_history");
      const entry = { eventId: event.event_id, source, order: events.size,
        startMs: event.start_ms, endMs: event.end_ms, text: event.delta };
      const previous = events.get(entry.eventId);
      if (previous) {
        if (previous.source !== source || previous.text !== entry.text || previous.startMs !== entry.startMs || previous.endMs !== entry.endMs) {
          throw new Error("conflicting_repair_history");
        }
        return false;
      }
      if (events.size >= 256 || chars + entry.text.length > 12_000) throw new Error("repair_history_limit");
      chars += entry.text.length;
      events.set(entry.eventId, Object.freeze(entry));
      return true;
    },
    snapshot() {
      if (discarded || ![...events.values()].some((entry) => entry.source === "caller" && entry.text.trim())) {
        throw new Error("repair_history_missing");
      }
      return Object.freeze([...events.values()]);
    },
    discard() { events.clear(); chars = 0; discarded = true; },
  });
}
