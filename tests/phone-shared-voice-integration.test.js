import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startVoiceFixture, callSid } from "./helpers/phone-voice-fixture.js";
import { createResidentStreamToken } from "../src/phone/voice/security.js";
import { liveSessionStart } from "../src/phone/voice/live.js";
import { createAssistantService } from "../src/phone/assistant/service.js";

const callId = "11111111-1111-4111-8111-111111111111";
const residentId = "22222222-2222-4222-8222-222222222222";
const nonce = "33333333-3333-4333-8333-333333333333";

test("general startup prompt declares the Live control token, policies and backend authority", () => {
  // This checks the payload we send. It cannot prove the real voice model emits
  // SpawnThinking or refrains from a spoken success claim; that needs a call.
  const capabilities = ["schedule_callback", "reschedule_callback", "cancel_task", "complete_task", "save_note", "developer_check", "developer_recover"];
  const prompt = liveSessionStart({ m1Enabled: true, voiceModel: "gpt-live-1" }, {
    generalAssistant: true,
    residentContext: { profile: { timeZone: "Europe/London" }, tasks: [], capabilities },
  }).session.instructions;
  assert.match(prompt, /Generate\s+<\|SpawnThinking\|>/);
  for (const heading of ["Backchannel policy", "Interruption policy", "Delegation policy", "Backend tools"]) {
    assert.ok(prompt.includes(heading), `Missing prompt section: ${heading}`);
  }
  assert.match(prompt, /Do not generate\s+<\|SpawnThinking\|>/i);
  for (const capability of capabilities) assert.ok(prompt.includes(capability), `Missing backend capability: ${capability}`);
  assert.match(prompt, /(?:never|do not|must not)[^.]{0,200}(?:saved|scheduled)[^.]{0,200}(?:unless|until|without|before)[^.]{0,120}(?:server|backend)|(?:wait|only)[^.]{0,120}(?:server|backend)[^.]{0,120}(?:result|confirm)[^.]{0,120}(?:saved|scheduled)/i);
});

async function fixture(t, { plan = async () => ({ kind: "reply", reply: "Leaves change colour as chlorophyll breaks down." }),
  confirm = async () => { throw Error("An ordinary question must never confirm a task."); }, limits = {} } = {}) {
  const planned = [];
  const planInputs = [];
  const confirmationInputs = [];
  const service = {
    async plan(input) {
      planned.push(input.history);
      planInputs.push(input);
      return plan(input);
    },
    async confirm(input) { confirmationInputs.push(input); return confirm(input); },
  };
  const controller = {
    generalAssistant: service,
    incoming() {}, outgoing() {}, authenticate() {}, connect() {},
    async admitStream() { return {
      binding: { call_id: callId, resident_id: residentId, task_id: "44444444-4444-4444-8444-444444444444" },
      context: { profile: { timeZone: "Europe/London" }, tasks: [{ kind: "callback", title: "Water the plants", status: "scheduled" }], legacyTask: { request: "Old dripping tap request" } },
    }; },
  };
  const runtime = await startVoiceFixture(t, {
    settings: { ENABLE_M1_INTAKE: "true", ENABLE_SHARED_ASSISTANT: "true", SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SECRET_KEY: "sb_" + "secret_fixture_secret_0000000000000000" },
    limits: { transcriptQuietMs: 2, speechQuietMs: 2, conversationTickMs: 2, ...limits },
    m1Options: { controller },
  });
  const telephone = await runtime.openTelephone({ token: createResidentStreamToken(runtime.config, callSid, "inbound", nonce) });
  const provider = await runtime.providerReady;
  const startup = await provider.received.waitFor("session.start");
  return { ...runtime, telephone, provider, startup, planned, planInputs, confirmationInputs };
}

async function waitForCommentary(f, after = 0) {
  for (let count = 0; count < 100; count++) {
    const item = f.provider.received.messages.slice(after).find((event) => event.type === "session.commentary.append"
      && /^(?:Backend answer|Read this proposed action|Server-confirmed result:)/.test(event.content));
    if (item) return item;
    await delay(5);
  }
  throw Error("General delegation did not return commentary.");
}

async function waitUntil(predicate) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await delay(5); }
  throw Error("The fixture did not reach the expected bridge state.");
}

test("injected delegation exercises bridge wiring for a new topic without repair/reminder intake", async (t) => {
  // The provider deliberately supplies the delegation event. This covers the
  // bridge handler, not the model's decision to delegate in a real phone call.
  const f = await fixture(t);
  assert.ok(f.startup.session.instructions.includes("general conversational AI assistant"));
  assert.ok(f.startup.session.instructions.includes("switch goals freely"));
  assert.ok(!f.startup.session.instructions.includes("authenticated M1 repair-intake test"));
  f.provider.send({ type: "session.input_transcript.delta", event_id: "caller-leaves", delta: "Why do leaves change colour?", start_ms: 100, end_ms: 300 });
  f.provider.send({ type: "session.delegation.created", delegation: { id: "delegate-leaves", target: "client" } });
  const reply = await waitForCommentary(f);
  assert.equal(reply.delegation_id, "delegate-leaves");
  assert.ok(reply.content.includes("chlorophyll"));
  assert.equal(f.planned.length, 1);
  assert.equal(f.planned[0].at(-1).text, "Why do leaves change colour?");
  assert.equal(f.telephone.socket.readyState, 1);
  assert.ok(!JSON.stringify(f.logs).includes("Why do leaves"));
  f.telephone.stop();
  await f.telephone.closed;
});

test("star is ignored during general conversation and hash still ends the call", async (t) => {
  const f = await fixture(t);
  f.telephone.send({ event: "dtmf", dtmf: { digit: "*" } });
  f.telephone.send({ event: "media", media: { track: "inbound", payload: Buffer.alloc(160, 0xff).toString("base64") } });
  await f.provider.received.waitFor("session.input_audio.append");
  assert.equal(f.telephone.socket.readyState, 1);
  assert.equal(f.planned.length, 0);
  f.telephone.send({ event: "dtmf", dtmf: { digit: "#" } });
  await f.telephone.closed;
  assert.ok(f.logs.some((entry) => entry.reason === "caller_ended_test"));
});

test("pending work gives one neutral acknowledgment, allows its audio and excludes progress captions from task evidence", async (t) => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const f = await fixture(t, { plan: () => pending });
  const audio = Buffer.alloc(160, 0).toString("base64");
  f.provider.send({ type: "session.input_transcript.delta", event_id: "caller-reminder", delta: "Remind me about plants", start_ms: 100, end_ms: 300 });
  f.provider.send({ type: "session.delegation.created", delegation: { id: "pending-reminder", target: "client" } });
  const progress = (event) => event.type === "session.commentary.append" && event.content === "I’m checking that now.";
  await waitUntil(() => f.provider.received.messages.some(progress));
  assert.equal(f.provider.received.messages.filter(progress).length, 1);
  await waitUntil(() => f.planned.length === 1);

  // The runtime requests a neutral progress phrase. These injected audio and
  // captions exercise transport and evidence handling, not model compliance.
  f.provider.send({ type: "session.output_audio.delta", delta: audio });
  f.provider.send({ type: "session.output_transcript.delta", event_id: "progress-caption", delta: "I’m checking that now.", start_ms: 350, end_ms: 450 });
  await f.telephone.received.waitFor("media");
  const progressMark = await f.telephone.received.waitFor("mark");
  f.telephone.send({ event: "mark", mark: { name: progressMark.mark.name } });
  // A second injected delegation is only a same-socket processing barrier here;
  // these fixtures do not establish real model delegation or speech behavior.
  f.provider.send({ type: "session.delegation.created", delegation: { id: "pending-barrier", target: "client" } });
  await waitUntil(() => f.logs.filter((entry) => entry.event === "assistant_delegation_received").length >= 2);
  assert.equal(f.telephone.received.messages.filter((event) => event.event === "media").length, 1);
  assert.equal(f.provider.received.messages.filter(progress).length, 1);
  assert.equal(f.confirmationInputs.length, 0);
  assert.ok(!f.provider.received.messages.some((event) => event.type === "session.commentary.append" && event.content.startsWith("Server-confirmed result:")));

  resolve({ kind: "reply", reply: "Nothing has been scheduled. What time should I call?" });
  const result = await waitForCommentary(f);
  assert.ok(result.content.includes("Nothing has been scheduled"));
  f.provider.send({ type: "session.output_audio.delta", delta: audio });
  await waitUntil(() => f.telephone.received.messages.filter((event) => event.event === "media").length === 2);
  const resumedMark = f.telephone.received.messages.filter((event) => event.event === "mark").at(-1);
  f.telephone.send({ event: "mark", mark: { name: resumedMark.mark.name } });
  f.provider.send({ type: "session.input_transcript.delta", event_id: "caller-next", delta: "What reminders exist?", start_ms: 500, end_ms: 600 });
  f.provider.send({ type: "session.delegation.created", delegation: { id: "next-question", target: "client" } });
  await waitUntil(() => f.planInputs.length === 2);
  assert.ok(!f.planInputs[1].history.some((event) => event.text.includes("I’m checking that now.")));
  assert.equal(f.confirmationInputs.length, 0);
  f.telephone.stop(); await f.telephone.closed;
});

test("real bridge tolerates PCM activity and delayed marks/captions before one fresh semantic confirmation", async (t) => {
  // This exercises actual fake-provider/Twilio WebSockets and PCMU frames. The
  // model events and semantic verdict are fixtures, not live provider evidence.
  let routes = 0;
  let writes = 0;
  const proposal = { id: "66666666-6666-4666-8666-666666666666", nonce: "77777777-7777-4777-8777-777777777777",
    hash: "a".repeat(64), operation: "schedule_callback", summary: "Call you in five minutes about fictional plants." };
  const spoken = "I'll phone in five minutes about the fictional plants. Is that correct, and shall I go ahead?";
  const blocked = "All set; your callback is scheduled.";
  const f = await fixture(t, {
    plan: async () => ++routes === 1 ? { kind: "propose", proposal } : { kind: "reply", reply: "The confirmed callback is about fictional plants." },
    confirm: async (input) => {
      assert.equal(input.readbackText, spoken);
      assert.deepEqual(input.replyHistory.map((event) => event.text), ["Yes, please go ahead."]);
      assert.equal(input.isCurrent(), true);
      // The read-only assessment can start before audible playback drains;
      // consuming permission and writing must still wait for the strict gate.
      assert.equal(await input.waitForReady(), true);
      assert.equal(input.isCurrent(true), true);
      writes++;
      return { status: "confirmed", taskId: "88888888-8888-4888-8888-888888888888" };
    },
  });
  f.provider.send({ type: "session.input_transcript.delta", event_id: "request-real-order", delta: "Call in five minutes about fictional plants.", start_ms: 0, end_ms: 300 });
  f.provider.send({ type: "session.delegation.created", delegation: { id: "proposal-real-order", target: "client" } });
  const presentation = await waitForCommentary(f);
  assert.ok(presentation.content.startsWith("Read this proposed action"));
  assert.equal(routes, 1);

  f.provider.send({ type: "session.output_audio.delta", delta: Buffer.alloc(320, 0).toString("base64") });
  await f.telephone.received.waitFor("media");
  const mark = await f.telephone.received.waitFor("mark");
  // Audio energy before output captions must not permanently erase the pending
  // readback. Its timestamp boundary and actual caller text decide eligibility.
  const activePcmu = Buffer.alloc(320, 0).toString("base64");
  f.telephone.send({ event: "media", media: { track: "inbound", payload: activePcmu } });
  await waitUntil(() => f.provider.received.messages.filter((event) => event.type === "session.input_audio.append").length >= 2);
  f.provider.send({ type: "session.output_transcript.delta", event_id: "actual-readback-real-order", delta: spoken, start_ms: 500, end_ms: 1500 });

  f.telephone.send({ event: "media", media: { track: "inbound", payload: activePcmu } });
  await waitUntil(() => f.provider.received.messages.filter((event) => event.type === "session.input_audio.append").length >= 4);
  f.provider.send({ type: "session.delegation.created", delegation: { id: "yes-before-caption", target: "client" } });
  f.provider.send({ type: "session.output_transcript.delta", event_id: "muted-post-caller-ack", delta: blocked, start_ms: 2400, end_ms: 2700 });
  f.provider.send({ type: "session.input_transcript.delta", event_id: "fresh-yes-real-order", delta: "Yes, please go ahead.", start_ms: 2000, end_ms: 2300 });
  await delay(30);
  assert.equal(f.confirmationInputs.length, 1);
  assert.equal(writes, 0);
  assert.equal(routes, 1);

  f.telephone.send({ event: "mark", mark: { name: mark.mark.name } });
  await waitUntil(() => f.provider.received.messages.some((event) => event.type === "session.commentary.append" && event.content.startsWith("Server-confirmed result:")));
  assert.equal(f.confirmationInputs.length, 1);
  assert.equal(writes, 1);
  assert.equal(routes, 1);

  f.provider.send({ type: "session.input_transcript.delta", event_id: "status-after-confirmation", delta: "What tasks do I have?", start_ms: 3000, end_ms: 3300 });
  f.provider.send({ type: "session.delegation.created", delegation: { id: "status-real-order", target: "client" } });
  await waitUntil(() => f.planInputs.length === 2);
  assert.ok(!f.planInputs[1].history.some((event) => event.text.includes(blocked)));
  assert.equal(f.confirmationInputs.length, 1);
  assert.equal(writes, 1);
  f.telephone.stop(); await f.telephone.closed;
  assert.ok(!JSON.stringify(f.logs).includes(blocked));
});

test("raw PCMU activity postpones a confirmed verdict until quiet without restarting the semantic request", async (t) => {
  let routes = 0;
  let writes = 0;
  let assessments = 0;
  let activeSignal;
  let release;
  const verdict = new Promise((resolve) => { release = resolve; });
  const proposal = { id: "66666666-6666-4666-8666-666666666666", nonce: "77777777-7777-4777-8777-777777777777",
    hash: "a".repeat(64), operation: "schedule_callback", summary: "Call you in five minutes about fictional plants." };
  const semantic = createAssistantService({ config: { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-only" } },
    repository: { async confirm() { writes++; return { status: "confirmed", taskId: "88888888-8888-4888-8888-888888888888" }; } },
    assessor: async (input) => { assessments++; activeSignal = input.signal; return verdict; } });
  const f = await fixture(t, {
    plan: async () => { routes++; assert.equal(routes, 1, "Raw noise must not create another routing turn"); return { kind: "propose", proposal }; },
    confirm: (input) => semantic.confirm(input), limits: { speechQuietMs: 300 },
  });
  f.provider.send({ type: "session.input_transcript.delta", event_id: "noise-test-request", delta: "Call in five minutes about fictional plants.", start_ms: 0, end_ms: 300 });
  f.provider.send({ type: "session.delegation.created", delegation: { id: "noise-test-proposal", target: "client" } });
  await waitForCommentary(f);
  f.provider.send({ type: "session.output_audio.delta", delta: Buffer.alloc(160, 0).toString("base64") });
  await f.telephone.received.waitFor("media");
  const mark = await f.telephone.received.waitFor("mark");
  f.provider.send({ type: "session.output_transcript.delta", event_id: "noise-test-readback", delta: "I'll call in five minutes about fictional plants. Should I go ahead?", start_ms: 400, end_ms: 900 });
  f.telephone.send({ event: "mark", mark: { name: mark.mark.name } });
  const activity = Buffer.alloc(320, 0).toString("base64");
  f.telephone.send({ event: "media", media: { track: "inbound", payload: activity } });
  f.provider.send({ type: "session.input_transcript.delta", event_id: "noise-test-yes", delta: "Yes, please go ahead.", start_ms: 1200, end_ms: 1500 });
  f.provider.send({ type: "session.delegation.created", delegation: { id: "noise-test-confirmation", target: "client" } });
  await waitUntil(() => assessments === 1);
  assert.equal(writes, 0);
  assert.equal(activeSignal.aborted, false);
  const confirmationProgress = () => f.provider.received.messages.filter((event) => event.type === "session.commentary.append"
    && event.delegation_id === "noise-test-confirmation" && event.content === "I’m checking that now.");
  assert.equal(confirmationProgress().length, 1);

  // This energy could be a breath or room noise: no new transcript accompanies
  // it. It must delay commit until quiet, not cancel a valid caller reply.
  const forwardedBefore = f.provider.received.messages.filter((event) => event.type === "session.input_audio.append").length;
  f.telephone.send({ event: "media", media: { track: "inbound", payload: activity } });
  await waitUntil(() => f.provider.received.messages.filter((event) => event.type === "session.input_audio.append").length >= forwardedBefore + 2);
  assert.equal(activeSignal.aborted, false);
  assert.equal(assessments, 1);
  const evidence = f.confirmationInputs[0].replyHistory.map((event) => event.eventId);
  release({ decision: "confirm", sourceEventIds: evidence, clarificationQuestion: null });
  await delay(20);
  assert.equal(writes, 0);
  assert.equal(assessments, 1);
  await waitUntil(() => f.provider.received.messages.some((event) => event.type === "session.commentary.append" && event.content.startsWith("Server-confirmed result:")));
  assert.equal(writes, 1);
  assert.equal(assessments, 1);
  assert.equal(routes, 1);
  assert.equal(f.confirmationInputs.length, 1);
  assert.equal(confirmationProgress().length, 1);
  f.telephone.stop(); await f.telephone.closed;
});
