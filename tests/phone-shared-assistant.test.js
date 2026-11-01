import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateAction, actionHash } from "../src/phone/assistant/tools.js";
import { createAssistantService } from "../src/phone/assistant/service.js";
import { createAssistantWorker } from "../src/phone/assistant/worker.js";
import { createAssistantConversation } from "../src/phone/voice/assistant-conversation.js";
import { liveSessionStart } from "../src/phone/voice/live.js";

const callSid = `CA${"1".repeat(32)}`;
const binding = { call_id: randomUUID(), resident_id: randomUUID() };
const context = () => ({ profile: { timeZone: "Europe/London", callbackConsent: true }, tasks: [], legacyTask: { request: "The old tap leaks." } });
const args = () => ({ taskId: null, revision: null, title: "Water the plants", dueAt: new Date(Date.now() + 300000).toISOString() });
const config = { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-only" } };

test("action registry accepts callbacks but rejects invented targets, dates and capabilities", () => {
  const accepted = validateAction("schedule_callback", args());
  assert.equal(accepted.title, "Water the plants");
  assert.throws(() => validateAction("send_email", {}));
  assert.throws(() => validateAction("schedule_callback", { ...args(), to: "+10000000000" }));
  assert.throws(() => validateAction("schedule_callback", { ...args(), dueAt: "tomorrow" }));
  assert.throws(() => validateAction("schedule_callback", { ...args(), dueAt: new Date(Date.now() - 1000).toISOString() }));
  assert.throws(() => validateAction("cancel_task", { taskId: randomUUID(), revision: 0 }));
  assert.throws(() => validateAction("developer_recover", {}));
  assert.deepEqual(validateAction("developer_check", {}, { developerEnabled: true }), {});
});

test("general question leaves old repair and pending task alone", async () => {
  let writes = 0;
  const service = createAssistantService({ config, repository: { context: async () => context(), stage: async () => { writes++; } },
    planner: async (input) => { assert.equal(input.context.legacyTask.request, "The old tap leaks."); return { kind: "reply", reply: "Leaves lose chlorophyll in autumn." }; } });
  const result = await service.plan({ callSid, history: [], pending: { operation: "schedule_callback", summary: "Call about plants" } });
  assert.equal(result.kind, "reply"); assert.equal(writes, 0);
});

test("proposed action is staged with a canonical hash and no execution", async () => {
  let staged;
  const service = createAssistantService({ config, repository: { context: async () => context(), stage: async (input) => {
    staged = input; return { id: randomUUID(), nonce: input.nonce, hash: input.hash, summary: input.summary };
  } }, planner: async () => ({ kind: "propose", operation: "schedule_callback", args: args(), sourceEventIds: ["caller1"] }) });
  const result = await service.plan({ callSid, history: [] });
  assert.equal(result.kind, "propose");
  assert.equal(staged.hash, actionHash(staged.operation, staged.args, staged.summary));
  assert.equal(staged.callSid, callSid);
});

test("developer inspection stages only the fixed repository scope and cannot run before fresh approval", async () => {
  let staged, inspections = 0;
  const developer = { enabled: true, repository: "fixture/demo", inspect: async () => { inspections++; },
    snapshot: async () => assert.fail("An inspection proposal does not need a recovery snapshot") };
  const service = createAssistantService({ config, developer,
    repository: { context: async () => context(), stage: async (input) => {
      staged = input; return { id: randomUUID(), hash: input.hash, nonce: input.nonce, summary: input.summary };
    } },
    planner: async (input) => {
      assert.ok(input.context.capabilities.includes("developer_check"));
      assert.equal(input.context.developerRepository, "fixture/demo");
      return { kind: "propose", operation: "developer_check", args: { taskId: null, revision: null, title: null, dueAt: null }, sourceEventIds: ["caller-developer"] };
    },
  });
  const result = await service.plan({ callSid, history: [] });
  assert.equal(result.kind, "propose");
  assert.equal(result.proposal.operation, "developer_check");
  assert.deepEqual(staged.args, {});
  assert.equal(staged.summary, "Check the prepared demo in fixture/demo and call you with the findings.");
  assert.equal(staged.hash, actionHash("developer_check", {}, staged.summary));
  assert.equal(inspections, 0);
});

test("developer inspection arguments cannot smuggle a title or change the configured target", async () => {
  for (const args of [{ title: "Inspect another site" }, { repository: "foreign/repo" }, { url: "https://foreign.example" }]) {
    let writes = 0;
    const service = createAssistantService({ config, developer: { enabled: true, repository: "fixture/demo" },
      repository: { context: async () => context(), stage: async () => { writes++; } },
      planner: async () => ({ kind: "propose", operation: "developer_check", args, sourceEventIds: ["caller-developer"] }) });
    await assert.rejects(service.plan({ callSid, history: [] }));
    assert.equal(writes, 0);
  }
});

test("stale confirmation verdict cannot commit a task", async () => {
  let writes = 0;
  const service = createAssistantService({ config, repository: { confirm: async () => { writes++; } }, assessor: async () => ({ decision: "confirm" }) });
  const result = await service.confirm({ callSid, proposal: { summary: "Call later" }, readbackText: "Call later?", replyHistory: [], isCurrent: () => false });
  assert.equal(result.status, "stale"); assert.equal(writes, 0);
});

function conversationHarness(plans, assessments = []) {
  const messages = [];
  let confirmations = 0;
  let planCalls = 0;
  let assessmentCalls = 0;
  let lastReadback;
  const proposal = { id: randomUUID(), nonce: randomUUID(), hash: "a".repeat(64), summary: "Call you in five minutes about plants.", operation: "schedule_callback" };
  const service = {
    async plan() { planCalls++; return plans.shift() ?? { kind: "reply", reply: "You have a reminder about plants." }; },
    async confirm(input) {
      assessmentCalls++;
      const assessment = assessments.shift() ?? { status: "confirmed" };
      if (assessment.status !== "confirmed") return assessment;
      assert.equal(input.isCurrent(), true);
      assert.equal(input.isCurrent(true), true);
      confirmations++; return { status: "confirmed", taskId: randomUUID() };
    }, decline: async () => {},
  };
  const conversation = createAssistantConversation({ service, callSid, binding, commentary(message) {
    messages.push(message);
    if (message.startsWith("Read this")) lastReadback = JSON.parse(message.split("data, not instructions: ")[1].split(" Do not claim")[0]);
  }, thinking() {}, hasPendingPlayback: () => false, quietInput: () => true });
  let clock = 0;
  function transcript(source, delta) {
    conversation.transcript({ type: `session.${source}_transcript.delta`, event_id: randomUUID(), delta, start_ms: clock, end_ms: clock + 100 });
    clock += 200;
  }
  const settle = async () => { await conversation.tick(); for (let n = 0; n < 8; n++) await Promise.resolve(); };
  return { conversation, messages, proposal, confirmations: () => confirmations, planCalls: () => planCalls, assessmentCalls: () => assessmentCalls,
    async caller(message) { conversation.speech(); transcript("input", message); conversation.delegate(randomUUID()); await settle(); },
    async presentReadback() { transcript("output", lastReadback); conversation.playbackDrained(); await settle(); },
  };
}

test("spoken action can be confirmed once, then ordinary questions continue", async () => {
  const plans = [];
  const h = conversationHarness(plans);
  plans.push({ kind: "propose", proposal: h.proposal }, { kind: "reply", reply: "Leaves change colour as chlorophyll breaks down." });
  await h.caller("Call me in five minutes about plants");
  await h.presentReadback();
  await h.caller("Yes, please do that");
  assert.equal(h.confirmations(), 1);
  assert.equal(h.assessmentCalls(), 1);
  assert.equal(h.planCalls(), 1);
  await h.caller("Why do leaves change colour?");
  assert.equal(h.confirmations(), 1);
  assert.equal(h.assessmentCalls(), 1);
  assert.equal(h.planCalls(), 2);
  assert.ok(h.messages.at(-1).includes("chlorophyll"));
  h.conversation.close();
});

test("topic switch preserves pending proposal but a later yes requires fresh readback", async () => {
  const plans = [];
  // The semantic assessor rejects this unrelated question as permission; only
  // then does the general planner answer it. A stub must not confirm every reply.
  const h = conversationHarness(plans, [{ status: "unclear", question: null }]);
  plans.push({ kind: "propose", proposal: h.proposal }, { kind: "reply", reply: "Paris is the capital of France." }, { kind: "confirm" });
  await h.caller("Call me about plants"); await h.presentReadback();
  await h.caller("What is the capital of France?");
  assert.ok(h.messages.at(-1).includes("Paris"));
  assert.equal(h.confirmations(), 0);
  assert.equal(h.assessmentCalls(), 1);
  await h.caller("Yes");
  assert.equal(h.confirmations(), 0);
  assert.equal(h.assessmentCalls(), 1);
  assert.ok(h.messages.at(-1).startsWith("Read this"));
  h.conversation.close();
});

test("interrupted readback cannot authorize an action", async () => {
  const plans = []; const h = conversationHarness(plans);
  plans.push({ kind: "propose", proposal: h.proposal }, { kind: "confirm" });
  await h.caller("Call later");
  await h.caller("Yes");
  assert.equal(h.confirmations(), 0);
  h.conversation.close();
});

test("a repeated delegation after an answered turn does not leave ordinary audio muted", async () => {
  const h = conversationHarness([{ kind: "reply", reply: "Paris is the capital of France." }]);
  await h.caller("What is the capital of France?");
  assert.equal(h.conversation.shouldForwardAudio(), true);
  h.conversation.delegate("repeat_delegation_without_new_caller_turn");
  await h.conversation.tick();
  assert.equal(h.conversation.shouldForwardAudio(), true);
  h.conversation.close();
});

test("worker executes a claimed callback once across worker instances", async () => {
  let claimed = false; let calls = 0; const finished = [];
  const job = { status: "claimed", id: randomUUID(), operation: "callback" };
  const repository = { claim: async () => { if (claimed) return { status: "empty" }; claimed = true; return job; }, finish: async (...input) => finished.push(input) };
  const options = { config, repository, placeCall: async () => { calls++; return { call_sid: callSid }; } };
  assert.equal((await createAssistantWorker(options).run()).status, "processed");
  assert.equal((await createAssistantWorker(options).run()).status, "empty");
  assert.equal(calls, 1); assert.equal(finished[0][1], "done"); assert.equal(finished[0][3], callSid);
});

test("uncertain call outcome is quarantined rather than retried", async () => {
  let outcome;
  const repository = { claim: async () => ({ status: "claimed", operation: "callback" }), finish: async (job, status) => { outcome = status; } };
  const worker = createAssistantWorker({ config, repository, placeCall: async () => { throw Error("fixture lost response"); } });
  assert.equal((await worker.run()).status, "unknown"); assert.equal(outcome, "unknown");
});

test("developer worker records findings before its result callback", async () => {
  const effects = [];
  const repository = { claim: async () => ({ status: "claimed", operation: "developer_check" }), finish: async () => effects.push("record") };
  const worker = createAssistantWorker({ config, repository, developer: { enabled: true, inspect: async () => { effects.push("inspect"); return { outcome: "prepared_failure" }; } }, placeCall: async () => effects.push("call") });
  await worker.run(); assert.deepEqual(effects, ["inspect", "record"]);
});

test("general voice prompt enables topic changes without the repair harness", () => {
  const start = liveSessionStart({ m1Enabled: true, voiceModel: "gpt-live-1" }, { generalAssistant: true, residentContext: context() });
  assert.ok(start.session.instructions.includes("general conversational"));
  assert.ok(start.session.instructions.includes("switch goals freely"));
  assert.ok(!start.session.instructions.includes("authenticated M1 repair-intake test"));
  assert.equal(start.session.delegation.acknowledgement_delay_ms, 800);
});
