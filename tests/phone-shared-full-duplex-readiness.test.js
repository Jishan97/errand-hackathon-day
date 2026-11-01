import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startVoiceFixture, callSid } from "./helpers/phone-voice-fixture.js";
import { createResidentStreamToken } from "../src/phone/voice/security.js";
import { createAssistantService } from "../src/phone/assistant/service.js";
import { createSpokenConfirmation } from "../src/phone/voice/spoken-confirmation.js";

const callId = "11111111-1111-4111-8111-111111111111";
const residentId = "22222222-2222-4222-8222-222222222222";
const nonce = "33333333-3333-4333-8333-333333333333";
const draftId = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";

async function until(predicate, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "The loopback audio fixture did not become ready.");
    await delay(5);
  }
}

test("settled captions and delegation start read-only planning during continuous input energy and delayed output marks", async (t) => {
  // Model handoff and audio are deliberately injected. This checks bridge
  // scheduling under full-duplex transport, not a real model's handoff policy.
  let planningCalls = 0;
  let confirmationCalls = 0;
  let planningStartedAt = null;
  let resolveEntered;
  const entered = new Promise((resolve) => { resolveEntered = resolve; });
  const service = {
    async plan() {
      planningCalls++;
      planningStartedAt = performance.now();
      resolveEntered();
      return { kind: "reply", reply: "No action has been saved. What time did you have in mind?" };
    },
    async confirm() { confirmationCalls++; throw Error("No proposal or permission exists."); },
  };
  const controller = {
    generalAssistant: service,
    incoming() {}, outgoing() {}, authenticate() {}, connect() {},
    async admitStream() {
      return { binding: { call_id: callId, resident_id: residentId },
        context: { profile: { timeZone: "Europe/London" }, tasks: [] } };
    },
  };
  const runtime = await startVoiceFixture(t, {
    settings: {
      ENABLE_M1_INTAKE: "true", ENABLE_SHARED_ASSISTANT: "true",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SECRET_KEY: "sb_" + "secret_fixture_secret_0000000000000000",
    },
    // Preserve the actual 1600 ms raw-energy guard. Only the settled-caption
    // delay is shortened; these two boundaries must serve different purposes.
    limits: { speechQuietMs: 1600, transcriptQuietMs: 20, conversationTickMs: 5 },
    m1Options: { controller },
  });
  const telephone = await runtime.openTelephone({ token: createResidentStreamToken(runtime.config, callSid, "inbound", nonce) });
  const provider = await runtime.providerReady;
  await provider.received.waitFor("session.start");
  await until(() => runtime.logs.some((entry) => entry.event === "voice_session_ready"));

  let inputPackets = 0, outputPackets = 0, receivedMarks = 0, acknowledgedMarks = 0;
  const pendingMarks = new Set();
  const markTimers = new Set();
  const activePcmu = Buffer.alloc(160, 0).toString("base64");
  const silentPcmu = Buffer.alloc(160, 0xff).toString("base64");
  const markListener = (bytes) => {
    const event = JSON.parse(bytes.toString());
    if (event.event !== "mark") return;
    receivedMarks++;
    pendingMarks.add(event.mark.name);
    const timer = setTimeout(() => {
      markTimers.delete(timer);
      if (telephone.socket.readyState !== 1) return;
      telephone.send({ event: "mark", mark: { name: event.mark.name } });
      pendingMarks.delete(event.mark.name);
      acknowledgedMarks++;
    }, 150);
    markTimers.add(timer);
  };
  telephone.socket.on("message", markListener);
  const pump = () => {
    if (telephone.socket.readyState === 1) {
      telephone.send({ event: "media", media: { track: "inbound", payload: activePcmu } });
      inputPackets++;
    }
    if (provider.socket.readyState === 1) {
      provider.send({ type: "session.output_audio.delta", delta: silentPcmu });
      outputPackets++;
    }
  };
  const audioTimer = setInterval(pump, 20);
  const stopAudio = () => {
    clearInterval(audioTimer);
    for (const timer of markTimers) clearTimeout(timer);
    markTimers.clear();
    telephone.socket.off("message", markListener);
  };
  t.after(stopAudio);
  pump();
  await until(() => acknowledgedMarks >= 2 && pendingMarks.size >= 3
    && provider.received.messages.filter((event) => event.type === "session.input_audio.append").length >= 3);
  const inputAtRequest = inputPackets;
  const outputAtRequest = outputPackets;
  const requestAt = performance.now();
  provider.send({ type: "session.input_transcript.delta", event_id: "settled-full-duplex-request",
    delta: "What can you help me with?", start_ms: 100, end_ms: 400 });
  provider.send({ type: "session.delegation.created", delegation: { id: "full-duplex-handoff", target: "client" } });

  let deadlineTimer;
  await Promise.race([entered, new Promise((resolve) => { deadlineTimer = setTimeout(resolve, 1000); })]);
  clearTimeout(deadlineTimer);
  const counters = { planningCalls, inputPacketsSinceRequest: inputPackets - inputAtRequest,
    outputPacketsSinceRequest: outputPackets - outputAtRequest, pendingMarks: pendingMarks.size,
    receivedMarks, acknowledgedMarks,
    handoffs: runtime.logs.filter((entry) => entry.event === "assistant_delegation_received").length,
    backendStarts: runtime.logs.filter((entry) => entry.event === "assistant_turn_started").length };
  assert.equal(telephone.socket.readyState, 1, "The audio fixture must stay connected.");
  assert.equal(planningCalls, 1, `Read-only planning stalled behind raw energy/playback: ${JSON.stringify(counters)}`);
  assert.ok(planningStartedAt - requestAt <= 500, `Read-only planning took ${Math.round(planningStartedAt - requestAt)} ms with a 20 ms caption-settle boundary.`);
  assert.ok(pendingMarks.size > 0, "Planning must begin while playback marks remain pending.");
  assert.equal(confirmationCalls, 0);
  assert.ok(!runtime.logs.some((entry) => entry.event === "assistant_action_confirmed"));
  stopAudio();
  telephone.stop();
  await telephone.closed;
});

test("read-only readiness does not bypass current spoken permission, quiet playback, or one-use consumption", async () => {
  let playback = false, quiet = true, writes = 0, assessments = 0;
  const gate = createSpokenConfirmation({ readbackMode: "semantic", hasPendingPlayback: () => playback });
  gate.begin({ binding: { callSid, callId, residentId, draftId, proposalHash: "a".repeat(64), revision: 1 },
    readbackText: "Call in five minutes about fictional plants.", confirmationQuestion: "Should I go ahead?" });
  gate.appendOutput({ type: "session.output_transcript.delta", event_id: "readback",
    delta: "Call in five minutes about fictional plants. Should I go ahead?", start_ms: 100, end_ms: 500 });
  gate.observeCaller({ type: "session.input_transcript.delta", event_id: "yes",
    delta: "Yes, please go ahead.", start_ms: 1000, end_ms: 1200 });
  const snapshot = gate.replySnapshot();
  const actualReadback = gate.deliveredReadback();
  const service = createAssistantService({ config: { agentModel: "gpt-6.1-sol", values: { OPENAI_API_KEY: "fixture-only" } },
    repository: { async confirm() { writes++; return { status: "confirmed", taskId }; } },
    assessor: async (input) => { assessments++; return { decision: "confirm", sourceEventIds: input.replyHistory.map((item) => item.eventId), clarificationQuestion: null }; },
  });
  const attempt = () => service.confirm({ callSid, proposal: { id: draftId, summary: "Call in five minutes about fictional plants." },
    readbackText: actualReadback, replyHistory: snapshot.history,
    waitForReady: async () => quiet && !playback,
    isCurrent(consume = false) {
      if (!gate.isEvidenceCurrent(snapshot)) return false;
      return consume ? quiet && !playback && Boolean(gate.consume(snapshot)) : true;
    },
  });
  quiet = false; playback = true; gate.observeSpeech();
  assert.equal((await attempt()).status, "not_ready");
  assert.equal(writes, 0);
  quiet = true;
  assert.equal((await attempt()).status, "not_ready");
  assert.equal(writes, 0);
  playback = false;
  assert.equal((await attempt()).status, "confirmed");
  assert.equal(writes, 1);
  assert.equal((await attempt()).status, "stale");
  assert.equal(writes, 1, "An issued approval can only commit once.");
  assert.equal(assessments, 4);
});
