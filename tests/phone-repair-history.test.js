import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepairHistory } from "../src/phone/voice/repair-history.js";

const fragment = (id, source, text) => ({ event_id: id, type: `session.${source}_transcript.delta`,
  delta: text, start_ms: 0, end_ms: 100 });

test("conversation snapshot preserves delivery order and caller/assistant ownership without treating a snapshot as approval", () => {
  const h = createRepairHistory();
  h.append(fragment("q", "output", "Which tap?"));
  h.append(fragment("a", "input", "The kitchen one."));
  assert.deepEqual(h.snapshot().map(({ eventId, source, order, text }) => ({ eventId, source, order, text })), [
    { eventId: "q", source: "assistant", order: 0, text: "Which tap?" },
    { eventId: "a", source: "caller", order: 1, text: "The kitchen one." },
  ]);
  assert.equal(h.append(fragment("a", "input", "The kitchen one.")), false);
  assert.throws(() => h.append(fragment("a", "input", "Changed text")), /conflicting/);
});

test("missing caller facts, invalid fragments, overflow and discarded data fail closed", () => {
  const h = createRepairHistory();
  h.append(fragment("q", "output", "Invented request"));
  assert.throws(() => h.snapshot(), /missing/);
  for (const event of [fragment("bad id", "input", "hello"), fragment("a", "input", "x".repeat(2001)),
    { ...fragment("b", "input", "hello"), end_ms: -1 }]) assert.throws(() => h.append(event));
  for (let i = 0; i < 5; i++) h.append(fragment(`large${i}`, "input", "x".repeat(2000)));
  assert.throws(() => h.append(fragment("overflow", "input", "x".repeat(2000))), /limit/);
  h.discard();
  assert.throws(() => h.snapshot(), /missing/);
  assert.throws(() => h.append(fragment("new", "input", "hello")), /discarded/);
});
