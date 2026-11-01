import { createHash, randomBytes, randomUUID } from "node:crypto";
import OpenAI from "openai";

const apiOrigin = "https://api.openai.com";
const maxResponseBytes = 256 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const safeProviderCodes = new Set([
  "invalid_request", "invalid_request_error", "invalid_value", "unsupported_value",
  "unknown_parameter", "unsupported_parameter", "missing_required_parameter", "invalid_type",
  "model_not_found", "model_not_supported", "unsupported_model", "invalid_model",
  "permission_denied", "insufficient_permissions", "invalid_api_key",
  "rate_limit_exceeded", "insufficient_quota", "parameter_out_of_range", "context_length_exceeded",
]);
const safeProviderTypes = new Set(["invalid_request_error", "authentication_error", "permission_error", "rate_limit_error", "server_error"]);
const safeProviderParameters = new Set([
  "agent", "agent.model", "agent.instructions", "agent.tools", "agent.multi_agent",
  "agent.multi_agent.enabled", "agent.reasoning", "agent.text", "model", "tools",
  "environment", "environment.type", "input", "metadata", "stream", "spend_control", "spend_control.limit",
  ...[0, 1].flatMap((index) => ["", ".type", ".enabled", ".name", ".parameters", ".description"].map((suffix) => `agent.tools.${index}${suffix}`)),
]);

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Explicit credentials and origin prevent SDK environment defaults from changing
// this diagnostic's destination, project headers, logging or retry behavior.
export function createProbeClient({ apiKey, requestTimeoutMs, fetcher = globalThis.fetch }) {
  return new OpenAI({
    apiKey,
    baseURL: `${apiOrigin}/v1`,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    maxRetries: 0,
    timeout: requestTimeoutMs,
    logLevel: "off",
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== apiOrigin || !url.pathname.startsWith("/v1/agents/sessions")) {
        throw new ProbeFailure("unexpected_provider_url");
      }
      // Send only this probe's headers. The SDK can inherit custom headers from
      // the user's shell; they must not override the explicit probe credentials.
      const headers = new Headers({
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "OpenAI-Beta": "agents=v1",
      });
      const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
      if (idempotencyKey && /^[a-f0-9-]{36}$/.test(idempotencyKey)) headers.set("Idempotency-Key", idempotencyKey);
      const response = await fetcher(input, { ...init, headers, redirect: "error" });
      if (Number(response.headers.get("content-length")) > maxResponseBytes) {
        await response.body?.cancel();
        throw new ProbeFailure("provider_response_too_large");
      }
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxResponseBytes) {
              await reader.cancel();
              throw new ProbeFailure("provider_response_too_large");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      return new Response(size ? Buffer.concat(chunks, size) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    },
  });
}

function receiptObject(text, receipt) {
  if (typeof text !== "string" || text.length > 2048) return false;
  try {
    const value = JSON.parse(text);
    return value && !Array.isArray(value) && Object.keys(value).length === 1 && value.receipt === receipt;
  } catch {
    return false;
  }
}

// The Agents API can normalize a submitted string into recorded input_text
// content parts. Both representations are documented function-output formats.
function functionOutputText(output) {
  if (typeof output === "string") return output;
  if (
    !Array.isArray(output) || !output.length || output.length > 8 ||
    output.some((part) => part?.type !== "input_text" || typeof part.text !== "string" || part.text.length > 2048)
  ) return null;
  const text = output.map((part) => part.text).join("");
  return text.length <= 2048 ? text : null;
}

function safeError(error, fallback) {
  if (error instanceof ProbeFailure) return { code: error.code };
  const status = error?.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const code = status === 401 ? "authentication_rejected"
      : status === 403 ? "agents_permission_rejected"
        : status === 404 ? "agents_or_model_unavailable"
          : status === 429 ? "provider_rate_limited" : fallback;
    const providerCode = error.code ?? error.error?.code;
    const providerType = error.type ?? error.error?.type;
    const parameter = typeof (error.param ?? error.error?.param) === "string"
      ? (error.param ?? error.error.param).replace(/\[(\d+)\]/g, ".$1") : null;
    return {
      code,
      http_status: status,
      ...(providerCode ? { provider_error_code: safeProviderCodes.has(providerCode) ? providerCode : "unrecognized" } : {}),
      ...(providerType ? { provider_error_type: safeProviderTypes.has(providerType) ? providerType : "unrecognized" } : {}),
      ...(parameter ? { provider_parameter: safeProviderParameters.has(parameter) ? parameter : "unrecognized" } : {}),
    };
  }
  return { code: fallback };
}

// No environment is read on import. The CLI supplies its private settings only
// when the user deliberately runs it; fixtures supply explicit fake values.
export async function runAgentsProbe(environment, {
  createClient = createProbeClient,
  randomValue = () => createHash("sha256").update(randomBytes(32)).digest("hex"),
  timeoutMs = 90_000,
  requestTimeoutMs = 10_000,
  cleanupTimeoutMs = 15_000,
  pollIntervalMs = 500,
  maxPolls = 120,
  maxPages = 3,
} = {}) {
  const report = {
    status: "failed",
    evidence: "agents_api_function_round_trip",
    function_request_validated: false,
    function_executions: 0,
    function_result_submitted: false,
    function_result_consumed: false,
    turn_completed: false,
    cleanup: { status: "not_created", api_removal_acknowledged: false, cancellation_requested: false },
    creation_outcome: "not_attempted",
    provider_requests_made: false,
    calls_placed: false,
    emails_sent: false,
    task_writes: false,
    sandbox_created: false,
    m0_complete: false,
  };
  const apiKey = typeof environment?.OPENAI_API_KEY === "string" ? environment.OPENAI_API_KEY.trim() : "";
  const model = typeof environment?.OPENAI_AGENT_MODEL === "string" ? environment.OPENAI_AGENT_MODEL.trim() : "";
  if (!apiKey || apiKey.length > 512 || /[\r\n]/.test(apiKey)) return { ...report, code: "openai_api_key_required" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) return { ...report, code: "explicit_agent_model_required" };
  if (
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000 ||
    !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30_000 ||
    !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5000 ||
    !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 240 ||
    !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3
  ) return { ...report, code: "invalid_probe_limits" };

  const deadline = Date.now() + timeoutMs;
  let sessions;
  let sessionId;
  let binding;
  let turnTerminal = false;
  let phase = "create_session";

  async function request(operation, until, label) {
    const remaining = until - Date.now();
    if (remaining <= 0) throw new ProbeFailure(`${label}_timeout`);
    const controller = new AbortController();
    let timer;
    try {
      report.provider_requests_made = true;
      return await Promise.race([
        Promise.resolve().then(() => operation({
          signal: controller.signal,
          timeout: Math.min(requestTimeoutMs, remaining),
          maxRetries: 0,
          headers: { "Idempotency-Key": randomUUID() },
        })),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ProbeFailure(`${label}_timeout`));
            controller.abort();
          }, Math.min(requestTimeoutMs, remaining));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function pause(until) {
    if (Date.now() >= until) throw new ProbeFailure("probe_timeout");
    if (pollIntervalMs) await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, until - Date.now())));
  }

  function validateSession(session) {
    if (
      !session || session.id !== sessionId || session.agent?.model !== model ||
      session.environment?.type !== "none" || !Array.isArray(session.required_actions) ||
      !["idle", "in_progress", "requires_action", "failed"].includes(session.status)
    ) throw new ProbeFailure("invalid_session_response");
    if (session.status === "failed") throw new ProbeFailure("agent_session_failed");
  }

  async function inspectItems() {
    const items = [];
    let after;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await request((options) => sessions.items.list(sessionId, {
        order: "asc", limit: 25, ...(after ? { after } : {}),
      }, options), deadline, "read_items");
      if (!Array.isArray(page?.data) || page.data.length > 25 || typeof page.has_more !== "boolean") {
        throw new ProbeFailure("invalid_items_response");
      }
      items.push(...page.data);
      if (!page.has_more) break;
      if (pageNumber === maxPages - 1) throw new ProbeFailure("item_page_limit");
      const next = page.last_id ?? page.data.at(-1)?.id;
      if (typeof next !== "string" || !idPattern.test(next) || next === after) throw new ProbeFailure("invalid_items_cursor");
      after = next;
    }
    const outputs = items.filter((item) => item.type === "function_call_output" && item.turn_id === binding.turnId && item.call_id === binding.callId);
    const finals = items.filter((item) => item.type === "message" && item.role === "assistant" && item.phase === "final_answer" && item.turn_id === binding.turnId);
    if (!outputs.length || !finals.length) return false;
    const output = outputs[0];
    const receiptMatches = receiptObject(functionOutputText(output.output), binding.receipt);
    if (outputs.length !== 1 || output.status !== "completed" || output.error != null || !receiptMatches) {
      report.tool_output_check = {
        matching_items: outputs.length,
        status: ["in_progress", "completed", "failed", "incomplete"].includes(output.status) ? output.status : output.status == null ? "missing" : "unrecognized",
        error_field: output.error === null ? "null" : output.error === undefined ? "absent" : "present",
        output_format: typeof output.output === "string" ? "string" : Array.isArray(output.output) ? "content_array" : output.output == null ? "missing" : "unrecognized",
        ...(Array.isArray(output.output) ? { content_types: [...new Set(output.output.slice(0,8).map((part) => ["input_text", "input_image"].includes(part?.type) ? part.type : "unrecognized"))] } : {}),
        receipt_matches: receiptMatches,
      };
      throw new ProbeFailure("tool_result_not_verified");
    }
    if (finals.length !== 1 || finals[0].status !== "completed" || !Array.isArray(finals[0].content)) {
      throw new ProbeFailure("invalid_final_answer");
    }
    const content = finals[0].content;
    if (content.length > 8 || content.some((part) => part.type !== "output_text" || typeof part.text !== "string" || part.text.length > 2048)) {
      throw new ProbeFailure("invalid_final_answer");
    }
    if (!receiptObject(content.map((part) => part.text).join(""), binding.receipt)) throw new ProbeFailure("result_not_consumed");
    return true;
  }

  async function cleanup() {
    if (!sessionId) {
      if (report.creation_outcome === "unknown") report.cleanup.status = "unconfirmed";
      return;
    }
    report.cleanup.status = "unconfirmed";
    const until = Date.now() + cleanupTimeoutMs;
    try {
      if (!turnTerminal) {
        await request((options) => sessions.events.create(sessionId, {
          events: [{ type: "agent.session.input.cancel" }],
        }, options), until, "cancel_session");
        report.cleanup.cancellation_requested = true;
      }
      for (let count = 0; count < maxPolls; count += 1) {
        const session = await request((options) => sessions.retrieve(sessionId, options), until, "cleanup_session");
        if (session?.id !== sessionId) throw new ProbeFailure("cleanup_session_mismatch");
        const turns = await request((options) => sessions.turns.list(sessionId, { order: "desc", limit: 5 }, options), until, "cleanup_turns");
        if (!Array.isArray(turns?.data) || turns.has_more !== false || turns.data.length > 5) throw new ProbeFailure("cleanup_turns_unconfirmed");
        if (["idle", "failed"].includes(session.status) && turns.data.every((turn) => (
          turn.session_id === sessionId && terminalStatuses.has(turn.status)
        ))) {
          const removed = await request((options) => sessions.delete(sessionId, options), until, "delete_session");
          if (removed?.id !== sessionId || removed.object !== "agent.session.deleted" || removed.deleted !== true) {
            throw new ProbeFailure("deletion_not_acknowledged");
          }
          report.cleanup.status = "deleted";
          report.cleanup.api_removal_acknowledged = true;
          return;
        }
        await pause(until);
      }
    } catch {
      // Cleanup failure must never leak identifiers, payloads or raw provider errors.
    }
  }

  try {
    const client = createClient({ apiKey, requestTimeoutMs });
    sessions = client?.beta?.agents?.sessions;
    if (!sessions?.create || !sessions?.retrieve || !sessions?.events?.create || !sessions?.turns?.retrieve || !sessions?.turns?.list || !sessions?.items?.list || !sessions?.delete) {
      throw new ProbeFailure("agents_sdk_surface_unavailable");
    }
    report.creation_outcome = "unknown";
    let session = await request((options) => sessions.create({
      environment: { type: "none" },
      agent: {
        model,
        instructions: "Run only this harmless Errand integration test. Call get_test_value exactly once with an empty object. After receiving its result, your final answer must be exactly the returned JSON object with its receipt field, without Markdown or extra text. Do not invent a receipt or call other tools.",
        multi_agent: { enabled: false },
        tools: [
          { type: "function", name: "get_test_value", description: "Return a fresh diagnostic receipt to prove an application function round trip.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
          { type: "programmatic_tool_calling", enabled: false },
        ],
      },
      input: "Run the single get_test_value function round trip now, then return its JSON receipt.",
      metadata: { purpose: "errand_m0_function_probe" },
      stream: false,
    }, options), deadline, phase);
    if (typeof session?.id !== "string" || !idPattern.test(session.id)) throw new ProbeFailure("session_creation_unconfirmed");
    sessionId = session.id;
    report.creation_outcome = "created";
    if (session.environment?.type && session.environment.type !== "none") report.sandbox_created = true;
    for (let count = 0; count < maxPolls; count += 1) {
      validateSession(session);
      const actions = session.required_actions;
      let turn;
      if (actions.length) {
        if (actions.length !== 1) throw new ProbeFailure("unexpected_required_actions");
        const action = actions[0];
        if (
          action?.type !== "function_call" || action.name !== "get_test_value" ||
          typeof action.turn_id !== "string" || !idPattern.test(action.turn_id) ||
          typeof action.call_id !== "string" || !idPattern.test(action.call_id) ||
          !action.arguments || typeof action.arguments !== "object" || Array.isArray(action.arguments) || Object.keys(action.arguments).length
        ) throw new ProbeFailure("invalid_function_request");
        if (binding && (binding.turnId !== action.turn_id || binding.callId !== action.call_id)) throw new ProbeFailure("unexpected_additional_function_call");
        if (!binding) {
          phase = "validate_function_turn";
          turn = await request((options) => sessions.turns.retrieve(action.turn_id, { session_id: sessionId }, options), deadline, phase);
          if (turn?.id !== action.turn_id || turn.session_id !== sessionId || !["queued", "in_progress", "waiting", "completed", "failed", "cancelled"].includes(turn.status)) {
            throw new ProbeFailure("invalid_turn_response");
          }
          turnTerminal = terminalStatuses.has(turn.status);
          if (turnTerminal) throw new ProbeFailure("function_on_terminal_turn");
          report.function_request_validated = true;
          const receipt = randomValue();
          if (typeof receipt !== "string" || !/^[a-f0-9]{64}$/.test(receipt)) throw new ProbeFailure("invalid_diagnostic_receipt");
          binding = { turnId: action.turn_id, callId: action.call_id, receipt };
          report.function_executions = 1;
          phase = "submit_tool_result";
          await request((options) => sessions.events.create(sessionId, {
            events: [{ type: "agent.session.input.tool_result", turn_id: binding.turnId, call_id: binding.callId, success: true, output: JSON.stringify({ receipt }) }],
          }, options), deadline, phase);
          report.function_result_submitted = true;
        }
      }
      if (binding) {
        phase = "read_turn";
        turn = await request((options) => sessions.turns.retrieve(binding.turnId, { session_id: sessionId }, options), deadline, phase);
        if (turn?.id !== binding.turnId || turn.session_id !== sessionId || !["queued", "in_progress", "waiting", "completed", "failed", "cancelled"].includes(turn.status)) {
          throw new ProbeFailure("invalid_turn_response");
        }
        turnTerminal = terminalStatuses.has(turn.status);
        if (["failed", "cancelled"].includes(turn.status)) throw new ProbeFailure("agent_turn_failed");
        if (turn.status === "completed") {
          report.turn_completed = true;
          phase = "verify_result";
          if (await inspectItems()) {
            report.function_result_consumed = true;
            break;
          }
        }
      } else if (session.status === "idle") {
        const turns = await request((options) => sessions.turns.list(sessionId, { order: "desc", limit: 5 }, options), deadline, "read_initial_turns");
        if (!Array.isArray(turns?.data)) throw new ProbeFailure("invalid_turn_response");
        turnTerminal = turns.data.length > 0 && turns.data.every((turn) => turn.session_id === sessionId && terminalStatuses.has(turn.status));
        if (turns.data.some((turn) => terminalStatuses.has(turn.status))) throw new ProbeFailure("function_not_requested");
      }
      await pause(deadline);
      phase = "poll_session";
      session = await request((options) => sessions.retrieve(sessionId, options), deadline, phase);
    }
    if (!report.function_result_consumed) throw new ProbeFailure("round_trip_not_verified");
  } catch (error) {
    if (report.creation_outcome === "unknown" && Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      report.creation_outcome = "rejected";
    }
    Object.assign(report, safeError(error, `${phase}_failed`));
  } finally {
    await cleanup();
  }
  if (report.function_result_consumed && report.turn_completed && report.cleanup.api_removal_acknowledged) {
    report.status = "passed";
  } else if (!report.code) {
    report.code = "cleanup_unconfirmed";
  }
  return report;
}
