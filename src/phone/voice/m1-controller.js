import { randomUUID } from "node:crypto";
import { m1IsAvailable } from "../config.js";
import { buildTaskContext } from "../context/task-context.js";
import { callSidPattern, createResidentStreamToken, validateTwilioSignature } from "./security.js";
import { extractRepairProposal, assessRepairConfirmation } from "../agents/repair-proposal.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const xml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const twiml = (response, body) => response.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);

class VoiceRequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function authorize(request, config, path, { query = false } = {}) {
  if (!m1IsAvailable(config)) throw new VoiceRequestError(503, "m1_disabled_or_unconfigured");
  const url = new URL(request.originalUrl, config.values.PUBLIC_BASE_URL);
  const queryKey = query === true ? "challenge" : query;
  if (url.pathname !== path || url.origin !== config.values.PUBLIC_BASE_URL
    || (queryKey ? url.searchParams.size !== 1 || !uuidPattern.test(url.searchParams.get(queryKey) ?? "") : url.search)) {
    throw new VoiceRequestError(400, "invalid_voice_url");
  }
  if (typeof request.body !== "string") throw new VoiceRequestError(415, "form_body_required");
  const fields = new URLSearchParams(request.body);
  const parameters = Object.create(null);
  if (fields.size > 64) throw new VoiceRequestError(400, "invalid_voice_form");
  for (const [name, value] of fields) {
    if (Object.hasOwn(parameters, name)) throw new VoiceRequestError(400, "invalid_voice_form");
    parameters[name] = value;
  }
  if (!validateTwilioSignature({ signature: request.headers["x-twilio-signature"],
    url: `${config.values.PUBLIC_BASE_URL}${request.originalUrl}`, parameters, authToken: config.values.TWILIO_AUTH_TOKEN })) {
    throw new VoiceRequestError(403, "invalid_twilio_signature");
  }
  const direction = parameters.Direction === "inbound" ? "inbound" : parameters.Direction === "outbound-api" ? "outbound" : null;
  if (!direction || parameters.AccountSid !== config.values.TWILIO_ACCOUNT_SID || !callSidPattern.test(parameters.CallSid ?? "")
    || parameters.From !== config.values[direction === "inbound" ? "TEST_RESIDENT_NUMBER" : "TWILIO_FROM_NUMBER"]
    || parameters.To !== config.values[direction === "inbound" ? "TWILIO_FROM_NUMBER" : "TEST_RESIDENT_NUMBER"]) {
    throw new VoiceRequestError(403, "test_call_not_allowed");
  }
  return { parameters, direction, challengeId: url.searchParams.get("challenge"), draftId: url.searchParams.get("draft"), jobId: url.searchParams.get("job") };
}

export function createM1VoiceController({ config, repository, contextRepository, intakeRepository = null,
  proposalRepository = null, extractProposal = extractRepairProposal, assessConfirmation = assessRepairConfirmation, assistant = null }) {
  const wrap = (handler) => async (request, response) => {
    try { await handler(request, response); }
    catch (error) {
      const known = error instanceof VoiceRequestError;
      response.status(known ? error.status : 503).json({ error: { code: known ? error.code : "identity_service_unavailable" } });
    }
  };
  const redirect = (response) => twiml(response, `<Redirect method="POST">${xml(`${config.values.PUBLIC_BASE_URL}/api/voice/connect`)}</Redirect>`);
  const begin = (direction) => wrap(async (request, response) => {
    const verified = authorize(request, config, `/api/voice/${direction === "inbound" ? "incoming" : "outgoing"}`,
      { query: assistant && direction === "outbound" && request.originalUrl.includes("?") ? "job" : false });
    if (verified.direction !== direction) throw new VoiceRequestError(403, "test_call_not_allowed");
    const state = await repository.admitDemoCall({ callSid: verified.parameters.CallSid, direction });
    if (state.admitted !== true || state.admission_method !== "allowed_test_number") throw new VoiceRequestError(503, "demo_call_admission_unavailable");
    if (verified.jobId) await assistant.bindCallback(verified.parameters.CallSid, verified.jobId);
    redirect(response);
  });

  return Object.freeze({
    generalAssistant: assistant,
    intakeAvailable: !assistant && Boolean(intakeRepository),
    // A missing model never restores literal-transcript saving in production.
    proposalMode: !assistant && Boolean(proposalRepository),
    proposalAvailable: Boolean(proposalRepository && config.agentModel === "gpt-6.1-sol"),
    async prepareProposal({ callSid, binding, history, expectedTaskRevision = null, signal }) {
      if (!m1IsAvailable(config) || !proposalRepository || config.agentModel !== "gpt-6.1-sol" || !binding) {
        throw new Error("repair_proposal_unavailable");
      }
      const proposal = await extractProposal({ apiKey: config.values.OPENAI_API_KEY, model: config.agentModel, history, signal });
      if (signal?.aborted) throw new Error("repair_proposal_aborted");
      if (proposal.status === "needs_clarification") return { status: proposal.status, question: proposal.clarificationQuestion };
      const draft = await proposalRepository.stageRepairProposal({ callSid, summary: proposal.summary,
        sourceEventIds: proposal.sourceEventIds, expectedTaskRevision });
      if (signal?.aborted) {
        await proposalRepository.discardRepairProposal({ callSid, draftId: draft.draft_id });
        throw new Error("repair_proposal_aborted");
      }
      return { status: "ready", draft };
    },
    async armProposal(input) {
      if (!m1IsAvailable(config) || !proposalRepository) throw new Error("repair_proposal_unavailable");
      return await proposalRepository.armRepairProposal(input);
    },
    async assessSpokenConfirmation({ draft, readbackText, history, signal }) {
      if (!m1IsAvailable(config) || !proposalRepository || config.agentModel !== "gpt-6.1-sol") throw new Error("repair_confirmation_unavailable");
      return await assessConfirmation({ apiKey: config.values.OPENAI_API_KEY, model: config.agentModel,
        proposalSummary: draft.request, readbackText, replyHistory: history, signal });
    },
    async confirmProposal(input) {
      if (!m1IsAvailable(config) || !proposalRepository) throw new Error("repair_proposal_unavailable");
      return await proposalRepository.confirmSpokenRepairProposal(input);
    },
    async discardProposal(input) {
      if (!m1IsAvailable(config) || !proposalRepository) throw new Error("repair_proposal_unavailable");
      return await proposalRepository.discardRepairProposal(input);
    },
    async checkStorage() {
      if (!m1IsAvailable(config)) throw new Error("m1_disabled_or_unconfigured");
      return await repository.checkStorage();
    },
    incoming: begin("inbound"),
    outgoing: begin("outbound"),
    // Retired demo route: never inspect submitted digits or perform a mutation.
    authenticate: async (_request, response) => response.status(410).json({ error: { code: "demo_code_route_removed" } }),
    connect: wrap(async (request, response) => {
      const { parameters, direction } = authorize(request, config, "/api/voice/connect");
      const binding = await repository.getVerifiedCall({ callSid: parameters.CallSid });
      if (binding.direction !== direction) throw new VoiceRequestError(403, "invalid_call_binding");
      const nonce = randomUUID();
      const streamBinding = await repository.issueStream({ callSid: parameters.CallSid, nonce });
      const token = createResidentStreamToken(config, parameters.CallSid, direction, nonce);
      const mediaUrl = `${config.values.PUBLIC_BASE_URL.replace("https:", "wss:")}/api/media`;
      const afterStream = !assistant && !proposalRepository && intakeRepository && !streamBinding.task_id
        ? `<Redirect method="POST">${xml(`${config.values.PUBLIC_BASE_URL}/api/voice/review`)}</Redirect>`
        : "<Hangup/>";
      // The proposal workflow stays in Live through readback and spoken save.
      twiml(response, `<Connect><Stream url="${xml(mediaUrl)}"><Parameter name="bridgeToken" value="${xml(token)}"/></Stream></Connect>${afterStream}`);
    }),
    review: wrap(async (request, response) => {
      const { parameters } = authorize(request, config, "/api/voice/review");
      const binding = await repository.getVerifiedCall({ callSid: parameters.CallSid });
      if (proposalRepository || binding.task_id) return twiml(response, "<Hangup/>");
      let draft;
      try { draft = await intakeRepository.reviewIntake({ callSid: parameters.CallSid }); }
      catch { return twiml(response, "<Say>I could not verify a request to review. Please call again to check your saved task before trying again.</Say><Hangup/>"); }
      const action = `${config.values.PUBLIC_BASE_URL}/api/voice/confirm?draft=${draft.draft_id}`;
      // The exact read-back is OUTSIDE Gather. DTMF can confirm only in the next
      // phase; an interrupted model utterance is never treated as a read-back.
      return twiml(response, `<Say>${xml(draft.readback_text)}</Say><Gather input="dtmf" numDigits="1" finishOnKey="" timeout="15" actionOnEmptyResult="true" method="POST" action="${xml(action)}"><Say>Press one to confirm this exact request, or two to discard it.</Say></Gather><Say>No confirmation was received.</Say><Hangup/>`);
    }),
    confirm: wrap(async (request, response) => {
      const { parameters, draftId } = authorize(request, config, "/api/voice/confirm", { query: "draft" });
      await repository.getVerifiedCall({ callSid: parameters.CallSid });
      if (proposalRepository) return twiml(response, "<Hangup/>");
      try {
        if (parameters.Digits === "1") {
          await intakeRepository.confirmIntake({ callSid: parameters.CallSid, draftId });
          return twiml(response, "<Say>Your repair request is saved. A harmless diagnostic background job is queued. No email has been sent and no appointment has been booked. Goodbye.</Say><Hangup/>");
        }
        await intakeRepository.discardIntake({ callSid: parameters.CallSid, draftId });
        return twiml(response, "<Say>The proposed request was discarded. Goodbye.</Say><Hangup/>");
      } catch {
        return twiml(response, "<Say>I could not confirm the saved status. Please call again to check before submitting another request. Goodbye.</Say><Hangup/>");
      }
    }),
    async captureDraft({ callSid, binding, draft }) {
      if (!m1IsAvailable(config) || proposalRepository || !intakeRepository || !binding || binding.task_id) throw new Error("new_intake_unavailable");
      return await intakeRepository.stageIntake({ callSid, request: draft.request });
    },
    async runDiagnosticJob() {
      if (!m1IsAvailable(config) || !intakeRepository) throw new Error("diagnostic_job_unavailable");
      return await intakeRepository.runDiagnosticJob();
    },
    async admitStream({ callSid, streamSid, claims }) {
      if (!m1IsAvailable(config) || claims?.version !== 2) throw new Error("resident_admission_required");
      const binding = await repository.consumeStream({ callSid, streamSid, nonce: claims.nonce });
      if (binding.direction !== claims.direction) throw new Error("invalid_call_binding");
      const context = assistant ? await assistant.context(callSid) : binding.task_id ? await buildTaskContext({
        repository: contextRepository, verifiedResidentId: binding.resident_id,
        taskId: binding.task_id, purpose: binding.direction === "inbound" ? "inbound" : "decision",
      }) : null;
      return { binding, context, admission_method: "allowed_test_number" };
    },
  });
}
