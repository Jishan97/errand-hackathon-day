import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAssistantService } from "../src/phone/assistant/service.js";
import { createAssistantConversation } from "../src/phone/voice/assistant-conversation.js";

const callSid = `CA${"1".repeat(32)}`;
const binding = { call_id: randomUUID(), resident_id: randomUUID() };
const config = { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-only" } };
const context = () => ({ profile: { timeZone: "Europe/London", callbackConsent: true }, tasks: [] });
const callback = () => ({ kind: "propose", operation: "schedule_callback", args: { taskId: null, revision: null,
  title: "Water plants", dueAt: new Date(Date.now() + 300000).toISOString() }, sourceEventIds: ["caller1"] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function flush() { for (let n = 0; n < 24; n++) await Promise.resolve(); }

function conversation(service) {
  const messages = [];
  let clock = 0;
  const current = createAssistantConversation({ service, callSid, binding,
    commentary: (message) => messages.push(message), thinking() {}, hasPendingPlayback: () => false, quietInput: () => true });
  const transcript = (source, text) => {
    current.transcript({ type: `session.${source}_transcript.delta`, event_id: randomUUID(), delta: text, start_ms: clock, end_ms: clock + 100 });
    clock += 200;
  };
  return { current, messages,
    async caller(text, { delegate = true } = {}) {
      current.speech(); transcript("input", text); if (delegate) current.delegate(randomUUID()); await current.tick(); await flush();
    },
    async readback() {
      const message = messages.findLast((value) => value.startsWith("Read this"));
      assert.ok(message, "An actual server proposal must exist before a readback.");
      const text = JSON.parse(message.split("data, not instructions: ")[1].split(" Do not claim")[0]);
      transcript("output", text); current.playbackDrained(); await current.tick(); await flush();
    },
  };
}

test("new caller speech coalesces planning without aborting provider work or staging its stale proposal", async () => {
  const first = deferred();
  const signals = [];
  let stages = 0;
  const service = createAssistantService({ config, repository: { context: async () => context(), stage: async () => { stages++; throw Error("Stale plan must not stage"); } },
    planner: async (input) => { signals.push(input.signal); return signals.length === 1 ? first.promise : { kind: "reply", reply: "Leaves change colour as chlorophyll breaks down." }; } });
  const c = conversation(service);
  await c.caller("Call me in five minutes about plants");
  assert.equal(signals.length, 1);
  assert.equal(c.current.shouldForwardAudio(), false);
  await c.caller("Actually, why do leaves change colour?", { delegate: false });
  assert.equal(signals[0].aborted, false);
  first.resolve(callback()); await flush();
  assert.equal(stages, 0);
  assert.equal(c.messages.length, 0);
  await c.current.tick(); await flush();
  assert.equal(signals.length, 2);
  assert.equal(c.current.shouldForwardAudio(), true);
  assert.ok(c.messages.at(-1).includes("chlorophyll"));
  assert.equal(stages, 0);
  c.current.close();
});

test("a developer read superseded during snapshot loading cannot stage its old action", async () => {
  const snapshot = deferred();
  let snapshotStarted = false;
  let current = true;
  let stages = 0;
  const service = createAssistantService({ config,
    repository: { context: async () => context(), stage: async (input) => { stages++; return { id: randomUUID(), hash: input.hash, nonce: input.nonce, summary: input.summary }; } },
    developer: { enabled: true, repository: "fixture/demo", snapshot: async () => { snapshotStarted = true; return snapshot.promise; } },
    planner: async () => ({ kind: "propose", operation: "developer_recover", args: { taskId: null, revision: null, title: null, dueAt: null }, sourceEventIds: ["caller1"] }),
  });
  const planned = service.plan({ callSid, history: [], isCurrent: () => current });
  await flush(); assert.equal(snapshotStarted, true);
  current = false;
  snapshot.resolve({ broken: true, head: "a".repeat(40), fileSha: "b".repeat(40) });
  await assert.rejects(planned, /superseded/);
  assert.equal(stages, 0);
});

test("new caller captions still abort confirmation and prevent an older affirmative verdict from committing", async () => {
  const assessment = deferred();
  let assessmentSignal;
  let commits = 0;
  let plans = 0;
  const service = createAssistantService({ config, repository: {
    context: async () => context(),
    stage: async (input) => ({ id: randomUUID(), nonce: input.nonce, hash: input.hash, summary: input.summary }),
    confirm: async () => { commits++; return { status: "confirmed", taskId: randomUUID() }; },
  }, planner: async () => ++plans === 1 ? callback() : { kind: "confirm" },
  assessor: async (input) => { assessmentSignal = input.signal; return assessment.promise; } });
  const c = conversation(service);
  await c.caller("Call me in five minutes about plants"); await c.readback();
  await c.caller("Yes, please go ahead");
  assert.ok(assessmentSignal instanceof AbortSignal);
  assert.equal(plans, 1);
  assert.equal(assessmentSignal.aborted, false);
  await c.caller("No, do not schedule it", { delegate: false });
  assert.equal(assessmentSignal.aborted, true);
  assessment.resolve({ decision: "confirm", sourceEventIds: ["stale-confirmation"], clarificationQuestion: null });
  await flush();
  assert.equal(commits, 0);
  assert.ok(!c.messages.some((message) => message.startsWith("Server-confirmed result:")));
  c.current.close();
});
