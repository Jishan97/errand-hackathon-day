import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantConversation } from "../src/phone/voice/assistant-conversation.js";
import { createAssistantService } from "../src/phone/assistant/service.js";

const callSid = `CA${"a".repeat(32)}`;
const binding = { call_id: "11111111-1111-4111-8111-111111111111", resident_id: "22222222-2222-4222-8222-222222222222" };
const taskId = "33333333-3333-4333-8333-333333333333";
const proposal = { id: "44444444-4444-4444-8444-444444444444", hash: "a".repeat(64), nonce: "55555555-5555-4555-8555-555555555555",
  operation: "schedule_callback", summary: "Call you on 1 Nov 2026, 3:00 pm (Europe/London) about fictional plants." };
const spoken = "I'll phone tomorrow, November first, at three in the afternoon London time about the fictional plants. Is that correct, and shall I go ahead?";

function harness(options = {}) {
  const messages = [];
  const plans = [];
  const confirmations = [];
  let event = 0;
  let pendingPlayback = false;
  const service = {
    async plan(input) { plans.push(input); return plans.length === 1 ? { kind: "propose", proposal }
      : input.pending ? { kind: "confirm" } : { kind: "reply", reply: "The confirmed callback is about plants." }; },
    async confirm(input) { confirmations.push(input); if (options.confirm) return options.confirm(input); assert.equal(input.isCurrent(true), true); return { status: "confirmed", taskId }; },
    async decline() {},
  };
  const conversation = createAssistantConversation({ service, callSid, binding,
    commentary: (message) => messages.push(message), thinking() {}, pauseOutput() {},
    hasPendingPlayback: () => pendingPlayback, quietInput: () => true });
  const transcript = (source, delta, startMs, endMs) => conversation.transcript({ type: `session.${source}_transcript.delta`, event_id: `event_${++event}`, delta, start_ms: startMs, end_ms: endMs });
  const settle = async () => { await conversation.tick(); for (let n = 0; n < 12; n++) await Promise.resolve(); };
  return {
    conversation, messages, plans, confirmations, settle,
    output: (delta, startMs = 100, endMs = 500) => transcript("output", delta, startMs, endMs),
    async request() { conversation.speech(); transcript("input", "Please call me tomorrow at three about plants.", 0, 90); conversation.delegate("delegation_1"); await settle(); },
    reply(delta = "Yes, please go ahead.") { conversation.playbackDrained(); conversation.speech(); transcript("input", delta, 1000, 1200); conversation.delegate("delegation_2"); },
    async ask(delta) { conversation.speech(); transcript("input", delta, 2000, 2200); conversation.delegate("delegation_status"); await settle(); },
    playback(value) { pendingPlayback = value; },
  };
}

test("general conversation passes actual paraphrased captions to confirmation, never canonical requested text", async () => {
  const h = harness(); await h.request(); h.output(spoken); h.reply(); await h.settle();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.plans.length, 1);
  assert.equal(h.confirmations[0].readbackText, spoken);
  assert.notEqual(h.confirmations[0].readbackText, `${proposal.summary} Is this correct, and should I go ahead?`);
  assert.equal(h.confirmations[0].replyHistory[0].text, "Yes, please go ahead.");
  assert.ok(h.messages.at(-1).startsWith("Server-confirmed result:"));
  h.conversation.close();
});

test("missing delivered captions cannot be replaced with ideal requested readback", async () => {
  const h = harness(); await h.request(); h.reply(); await h.settle();
  assert.equal(h.confirmations.length, 0);
  assert.ok(h.messages.at(-1).startsWith("Read this proposed action"));
  h.conversation.close();
});

test("known after-caller muted captions are excluded from actual readback and conversation history", async () => {
  const h = harness(); await h.request(); h.output(spoken); h.reply();
  h.output("I already scheduled something different.", 1300, 1500);
  await h.settle();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.confirmations[0].readbackText, spoken);
  assert.equal(h.plans.length, 1);
  await h.ask("What reminders exist?");
  assert.equal(h.plans.length, 2);
  assert.ok(!h.plans.at(-1).history.some((entry) => entry.text.includes("something different")));
  h.conversation.close();
});

test("possibly late pre-reply captions arriving muted invalidate rather than alter approval evidence", async () => {
  const h = harness(); await h.request(); h.output(spoken); h.reply();
  h.output("Actually, at four instead.", 700, 900);
  await h.settle();
  assert.equal(h.confirmations.length, 0);
  assert.ok(h.messages.at(-1).startsWith("Read this proposed action"));
  assert.ok(!h.plans.at(-1).history.some((entry) => entry.text.includes("at four instead")));
  h.conversation.close();
});

test("late ambiguous readback data invalidates an in-flight confirmation verdict", async () => {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const result = new Promise((resolve) => { release = resolve; });
  const h = harness({ confirm: async (input) => { entered(); await result; assert.equal(input.isCurrent(), false); return { status: "stale" }; } });
  await h.request(); h.output(spoken); h.reply(); await h.settle(); await ready;
  h.output("Actually, at four instead.", 700, 900);
  release(); await h.settle();
  assert.ok(h.messages.at(-1).startsWith("Read this proposed action"));
  assert.ok(!h.messages.some((message) => message.startsWith("Server-confirmed result:")));
  h.conversation.close();
});

test("service forwards the full canonical scope and actual mismatched readback, then declines writes", async () => {
  let assessed;
  let writes = 0;
  const fullSummary = `${"A".repeat(250)} Leave the fix unmerged and call at three, not four.`;
  const actual = "Merge the fix and call at four. Should I go ahead?";
  const service = createAssistantService({ config: { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-key" } },
    repository: { async confirm() { writes++; } },
    assessor: async (input) => { assessed = input; return { decision: "unclear", clarificationQuestion: "May I repeat the correct action?" }; } });
  const result = await service.confirm({ callSid, proposal: { ...proposal, summary: fullSummary }, readbackText: actual,
    replyHistory: [], isCurrent: () => true });
  assert.equal(assessed.proposalSummary, fullSummary);
  assert.equal(assessed.readbackText, actual);
  assert.equal(result.status, "unclear"); assert.equal(writes, 0);
});

test("service refuses absent delivered text before invoking an assessor or storage", async () => {
  let effects = 0;
  const service = createAssistantService({ config: { values: {} }, repository: { confirm() { effects++; } }, assessor: async () => { effects++; } });
  for (const readbackText of [undefined, null, "", "   "]) {
    await assert.rejects(service.confirm({ callSid, proposal, readbackText, replyHistory: [], isCurrent: () => true }), /delivered_readback_required/);
  }
  assert.equal(effects, 0);
});
