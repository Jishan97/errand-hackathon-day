import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAssistantService } from "../src/phone/assistant/service.js";
import { createAssistantConversation } from "../src/phone/voice/assistant-conversation.js";
import { createSpokenConfirmation } from "../src/phone/voice/spoken-confirmation.js";

const callSid = `CA${"a".repeat(32)}`;
const binding = { call_id: randomUUID(), resident_id: randomUUID() };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
async function until(predicate) {
  const deadline = Date.now() + 500;
  while (!predicate()) { assert.ok(Date.now() < deadline, "Fixture did not settle"); await new Promise((resolve) => setTimeout(resolve, 2)); }
}

function fixture({ waitMs = 200, audibleProgress = false } = {}) {
  const verdict = deferred();
  const assessments = [], writes = [], progress = [], messages = [], logs = [], plans = [];
  let quiet = true, playback = false, event = 0, declines = 0;
  const service = createAssistantService({ config: { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-only-key" } }, repository: {
    context: async () => ({ profile: { timeZone: "Europe/London", callbackConsent: true }, tasks: [] }),
    stage: async (input) => ({ id: randomUUID(), nonce: input.nonce, hash: input.hash, summary: input.summary }),
    confirm: async (input) => { writes.push(input); return { status: "confirmed", taskId: randomUUID() }; },
    decline: async () => { declines++; },
  }, planner: async (input) => {
    plans.push(input);
    if (plans.length === 1) return { kind: "propose", operation: "schedule_callback", args: { taskId: null, revision: null, title: "Fictional plants", dueAt: new Date(Date.now() + 300000).toISOString() }, sourceEventIds: ["synthetic_request"] };
    return { kind: "reply", reply: "Leaves change colour when chlorophyll breaks down." };
  }, assessor: async (input) => { assessments.push(input); await verdict.promise; return { decision: "confirm", clarificationQuestion: null, sourceEventIds: input.replyHistory.map((item) => item.eventId) }; } });
  const conversation = createAssistantConversation({ service, callSid, binding,
    commentary: (message) => messages.push(message), thinking() {}, pauseOutput() {},
    ...(audibleProgress ? { progress: (message) => progress.push(message) } : {}),
    hasPendingPlayback: () => playback, quietInput: () => quiet, logger: (entry) => logs.push(entry),
    confirmationQuietWaitMs: waitMs, confirmationQuietPollMs: 5 });
  const transcript = (source, text, startMs, endMs) => conversation.transcript({ type: `session.${source}_transcript.delta`, event_id: `event_${++event}`, delta: text, start_ms: startMs, end_ms: endMs });
  const tick = async () => { await conversation.tick(); await flush(); };
  return { conversation, verdict, assessments, writes, progress, messages, logs, plans, declines: () => declines,
    quiet(value) { quiet = value; }, playback(value) { playback = value; },
    noise() { quiet = false; conversation.speech(); },
    output: (text, startMs, endMs) => transcript("output", text, startMs, endMs),
    async begin() {
      conversation.speech(); transcript("input", "Call in five minutes about fictional plants", 0, 100); conversation.delegate("request"); await tick();
      const expected = messages.findLast((message) => message.startsWith("Read this"));
      const actual = JSON.parse(expected.split("data, not instructions: ")[1].split(" Do not claim")[0]);
      transcript("output", actual, 200, 600); conversation.playbackDrained();
      conversation.speech(); transcript("input", "Yes, please go ahead.", 1000, 1200); conversation.delegate("confirmation"); await tick();
      assert.equal(assessments.length, 1);
      return actual;
    },
    async newCaller(text) { conversation.speech(); transcript("input", text, 1400, 1600); await flush(); },
    tick,
  };
}

test("raw noise preserves one read-only semantic assessment and holds commitment until quiet", async () => {
  const h = fixture(); await h.begin();
  const signal = h.assessments[0].signal;
  for (let n = 0; n < 5; n++) h.noise();
  assert.equal(signal.aborted, false);
  h.verdict.resolve(); await flush();
  assert.equal(h.writes.length, 0); assert.equal(h.assessments.length, 1);
  assert.ok(h.logs.some((entry) => entry.event === "assistant_confirmation_waiting_for_quiet"));
  h.quiet(true); await until(() => h.writes.length === 1);
  assert.equal(h.assessments.length, 1); assert.equal(h.plans.length, 1);
  assert.equal(h.declines(), 0);
  h.conversation.close();
});

test("new actual captions during the quiet wait still abort stale affirmative evidence", async () => {
  const h = fixture(); await h.begin(); h.noise(); h.verdict.resolve(); await flush();
  await h.newCaller("No, do not schedule it.");
  assert.equal(h.assessments[0].signal.aborted, true);
  await until(() => h.logs.some((entry) => entry.event === "assistant_turn_superseded"));
  assert.equal(h.writes.length, 0);
  h.conversation.close();
});

test("hangup while an unchanged verdict waits for quiet cannot save the action", async () => {
  const h = fixture(); await h.begin(); h.noise(); h.verdict.resolve(); await flush();
  h.conversation.close();
  assert.equal(h.assessments[0].signal.aborted, true);
  await until(() => h.logs.some((entry) => entry.event === "assistant_turn_superseded" && entry.reason === "call_closed"));
  assert.equal(h.writes.length, 0);
});

test("late uncertain readback scope still invalidates a verdict retained during raw noise", async () => {
  const h = fixture(); await h.begin(); h.noise(); h.verdict.resolve(); await flush();
  h.output("A possible pre-reply scope change", 700, 900);
  await until(() => h.messages.filter((message) => message.startsWith("Read this")).length === 2);
  assert.equal(h.writes.length, 0); assert.equal(h.assessments.length, 1);
  h.conversation.close();
});

test("bounded quiet expiry reports not saved, never decline, and leaves ordinary conversation available", async () => {
  const h = fixture({ waitMs: 25 }); await h.begin(); h.noise(); h.verdict.resolve();
  await until(() => h.messages.some((message) => message.includes("has not been saved yet")));
  assert.equal(h.writes.length, 0); assert.equal(h.declines(), 0); assert.equal(h.assessments.length, 1);
  assert.ok(h.logs.some((entry) => entry.event === "assistant_confirmation_quiet_limit"));
  h.quiet(true); await h.newCaller("Why do leaves change colour?"); h.conversation.delegate("new-topic"); await h.tick();
  assert.ok(h.messages.at(-1).includes("chlorophyll")); assert.equal(h.writes.length, 0);
  h.conversation.close();
});

test("one honest progress acknowledgment stays audible but its captions never enter consent evidence", async () => {
  const h = fixture({ audibleProgress: true }); const actualReadback = await h.begin();
  assert.equal(h.progress.length, 2); // One for each request/confirmation episode.
  assert.ok(h.progress.every((message) => message === "I’m checking that now."));
  assert.equal(h.conversation.shouldForwardAudio(), true);
  h.output("I am checking that now, a progress message only.", 1300, 1400);
  h.playback(true); h.verdict.resolve(); await flush();
  assert.equal(h.writes.length, 0);
  assert.equal(h.assessments[0].readbackText, actualReadback);
  assert.ok(h.assessments[0].replyHistory.every((entry) => entry.source === "caller"));
  h.playback(false); await until(() => h.writes.length === 1);
  assert.equal(h.assessments.length, 1); assert.equal(h.progress.length, 2);
  assert.ok(!JSON.stringify(h.logs).includes("progress message only"));
  h.conversation.close();
});

test("evidence freshness can survive raw noise and pending playback, but consumption stays strict", () => {
  let playback = false;
  const gate = createSpokenConfirmation({ readbackMode: "semantic", hasPendingPlayback: () => playback });
  gate.begin({ binding: { callSid, callId: binding.call_id, residentId: binding.resident_id, draftId: randomUUID(), proposalHash: "a".repeat(64), revision: 1 }, readbackText: "Call about fictional plants.", confirmationQuestion: "Should I go ahead?" });
  gate.appendOutput({ type: "session.output_transcript.delta", event_id: "readback", delta: "Call about fictional plants. Shall I go ahead?", start_ms: 100, end_ms: 500 });
  gate.observeCaller({ type: "session.input_transcript.delta", event_id: "yes", delta: "Yes, go ahead.", start_ms: 1000, end_ms: 1200 });
  const snapshot = gate.replySnapshot(); gate.observeSpeech(); playback = true;
  assert.equal(gate.isEvidenceCurrent(snapshot), true);
  assert.equal(gate.isCurrent(snapshot), false); assert.equal(gate.consume(snapshot), null);
  playback = false;
  gate.observeCaller({ type: "session.input_transcript.delta", event_id: "correction", delta: "But change the time.", start_ms: 1300, end_ms: 1600 });
  assert.equal(gate.isEvidenceCurrent(snapshot), false); assert.equal(gate.consume(snapshot), null);
});

test("noise without actual caller captions never creates semantic approval evidence", () => {
  const gate = createSpokenConfirmation({ readbackMode: "semantic", hasPendingPlayback: () => false });
  gate.begin({ binding: { callSid, callId: binding.call_id, residentId: binding.resident_id, draftId: randomUUID(), proposalHash: "a".repeat(64), revision: 1 }, readbackText: "Call about fictional plants." });
  gate.appendOutput({ type: "session.output_transcript.delta", event_id: "readback", delta: "Call about fictional plants. Shall I go ahead?", start_ms: 100, end_ms: 500 });
  for (let n = 0; n < 20; n++) gate.observeSpeech();
  assert.throws(() => gate.replySnapshot(), /spoken_reply_unavailable/);
});
