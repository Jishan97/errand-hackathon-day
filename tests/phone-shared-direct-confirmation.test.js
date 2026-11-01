import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAssistantConversation } from "../src/phone/voice/assistant-conversation.js";
import { createAssistantService } from "../src/phone/assistant/service.js";

const callSid = `CA${"a".repeat(32)}`;
const binding = { call_id: randomUUID(), resident_id: randomUUID() };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const action = (minutes = 5) => ({ kind: "propose", operation: "schedule_callback",
  args: { taskId: null, revision: null, title: "Water fictional plants", dueAt: new Date(Date.now() + minutes * 60000).toISOString() }, sourceEventIds: ["synthetic_request"] });

function harness({ laterPlans = [], verdicts = [] } = {}) {
  const messages = [], logs = [], assessments = [], stages = [], commits = [], planning = [];
  const plans = [action(), ...laterPlans];
  const service = createAssistantService({ config: { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-only-key" } }, repository: {
    context: async () => ({ profile: { timeZone: "Europe/London", callbackConsent: true }, tasks: [] }),
    stage: async (input) => { const draft = { id: randomUUID(), nonce: input.nonce, hash: input.hash, summary: input.summary }; stages.push({ input, draft }); return draft; },
    confirm: async (input) => { commits.push(input); return { status: "confirmed", taskId: randomUUID() }; },
    decline: async () => {},
  }, planner: async (input) => { planning.push(input); assert.ok(plans.length, "Unexpected routing request"); const plan = plans.shift(); return typeof plan === "function" ? plan(input) : plan; },
  assessor: async (input) => { assessments.push(input); assert.ok(verdicts.length, "Unexpected second assessment"); const verdict = verdicts.shift();
    return typeof verdict === "function" ? verdict(input) : { decision: verdict, sourceEventIds: input.replyHistory.map((item) => item.eventId), clarificationQuestion: null }; },
  });
  let clock = 0;
  const conversation = createAssistantConversation({ service, callSid, binding, commentary: (message) => messages.push(message),
    thinking() {}, pauseOutput() {}, hasPendingPlayback: () => false, quietInput: () => true, logger: (entry) => logs.push(entry) });
  const transcript = (source, text) => { conversation.transcript({ type: `session.${source}_transcript.delta`, event_id: randomUUID(), delta: text, start_ms: clock, end_ms: clock + 100 }); clock += 200; };
  const tick = async () => { await conversation.tick(); await flush(); };
  return { conversation, messages, logs, assessments, stages, commits, planning, tick,
    async caller(text, { delegate = true } = {}) { conversation.speech(); transcript("input", text); if (delegate) conversation.delegate(randomUUID()); await tick(); },
    async readback() { const message = messages.findLast((entry) => entry.startsWith("Read this")); assert.ok(message); transcript("output", JSON.parse(message.split("data, not instructions: ")[1].split(" Do not claim")[0])); conversation.playbackDrained(); await tick(); },
  };
}

test("fresh permission takes one direct semantic assessment with no second routing request", async () => {
  const h = harness({ verdicts: ["confirm"] });
  await h.caller("Call me in five minutes about fictional plants"); await h.readback();
  await h.caller("Yes, please go ahead");
  assert.equal(h.planning.length, 1); assert.equal(h.assessments.length, 1); assert.equal(h.commits.length, 1);
  assert.ok(h.messages.at(-1).startsWith("Server-confirmed result:"));
  assert.ok(h.logs.some((entry) => entry.event === "assistant_confirmation_finished" && Number.isSafeInteger(entry.elapsed_ms)));
  h.conversation.close();
  const summary = h.logs.findLast((entry) => entry.event === "assistant_conversation_summary");
  assert.equal(summary.confirmation_attempts, 1); assert.equal(summary.work_phase, "idle");
});

test("an unrelated question falls back to ordinary routing and preserves the pending proposal", async () => {
  const h = harness({ verdicts: ["unclear"], laterPlans: [{ kind: "reply", reply: "Leaves change colour as chlorophyll breaks down." }] });
  await h.caller("Call in five minutes"); await h.readback(); await h.caller("Why do leaves change colour?", { delegate: false });
  assert.equal(h.assessments.length, 1); assert.equal(h.planning.length, 2); assert.equal(h.commits.length, 0);
  assert.ok(h.messages.at(-1).includes("chlorophyll"));
  assert.ok(h.planning.at(-1).pending.summary.includes("fictional plants"));
  h.conversation.close();
});

test("a correction creates a fresh proposal, and subsequent permission commits only that proposal", async () => {
  const h = harness({ verdicts: ["correct", "confirm"], laterPlans: [action(10)] });
  await h.caller("Call in five minutes"); await h.readback(); await h.caller("Actually, ten minutes instead");
  assert.equal(h.stages.length, 2); assert.equal(h.commits.length, 0);
  assert.notEqual(h.stages[0].draft.id, h.stages[1].draft.id);
  await h.readback(); await h.caller("Yes, that new time is correct, go ahead");
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].proposal.id, h.stages[1].draft.id);
  assert.notEqual(h.commits[0].proposal.id, h.stages[0].draft.id);
  assert.equal(h.planning.length, 2); assert.equal(h.assessments.length, 2);
  h.conversation.close();
});

test("a fallback routing confirmation cannot overrule unclear consent or cause a second assessment", async () => {
  const h = harness({ verdicts: ["unclear"], laterPlans: [{ kind: "confirm" }] });
  await h.caller("Call in five minutes"); await h.readback(); await h.caller("Maybe, I am unsure");
  assert.equal(h.assessments.length, 1); assert.equal(h.commits.length, 0);
  assert.equal(h.messages.filter((entry) => entry.includes("Ask once what the caller")).length, 1);
  assert.equal(h.messages.filter((entry) => entry.startsWith("Read this")).length, 1);
  h.conversation.close();
});

test("new caller captions abort an in-flight semantic verdict and cannot commit the older yes", async () => {
  const assessment = deferred(); let activeSignal;
  const h = harness({ verdicts: [async (input) => { activeSignal = input.signal; return assessment.promise; }] });
  await h.caller("Call in five minutes"); await h.readback(); await h.caller("Yes, go ahead");
  assert.ok(activeSignal instanceof AbortSignal); assert.equal(activeSignal.aborted, false);
  await h.caller("No, do not schedule it", { delegate: false });
  assert.equal(activeSignal.aborted, true);
  assessment.resolve({ decision: "confirm", sourceEventIds: ["old-yes"], clarificationQuestion: null }); await flush();
  assert.equal(h.commits.length, 0);
  assert.ok(h.logs.some((entry) => entry.event === "assistant_turn_superseded" && entry.phase === "confirming"));
  h.conversation.close();
});

test("hangup cancels uncommitted direct assessment and records phase instead of a silent gap", async () => {
  const assessment = deferred(); let activeSignal;
  const h = harness({ verdicts: [async (input) => { activeSignal = input.signal; return assessment.promise; }] });
  await h.caller("Call in five minutes"); await h.readback(); await h.caller("Yes, go ahead");
  h.conversation.close(); assert.equal(activeSignal.aborted, true);
  const summary = h.logs.findLast((entry) => entry.event === "assistant_conversation_summary");
  assert.equal(summary.work_phase, "confirming"); assert.equal(summary.work_in_progress, true); assert.equal(summary.committing, false);
  assessment.resolve({ decision: "confirm", sourceEventIds: ["old-yes"], clarificationQuestion: null }); await flush();
  assert.equal(h.commits.length, 0);
  assert.ok(h.logs.some((entry) => entry.event === "assistant_turn_superseded" && entry.reason === "call_closed"));
  assert.ok(!JSON.stringify(h.logs).includes(callSid)); assert.ok(!JSON.stringify(h.logs).includes("fictional plants"));
});

test("a pending confirmation delegation arriving before yes captions mutes speculation immediately", async () => {
  const h = harness({ verdicts: ["confirm"] });
  await h.caller("Call in five minutes"); await h.readback();
  assert.equal(h.conversation.shouldForwardAudio(), true);
  h.conversation.speech(); h.conversation.delegate("confirmation-before-captions");
  assert.equal(h.conversation.shouldForwardAudio(), false);
  await h.caller("Yes, go ahead", { delegate: false });
  assert.equal(h.commits.length, 1); assert.equal(h.planning.length, 1);
  h.conversation.close();
});
