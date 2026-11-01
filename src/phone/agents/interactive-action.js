import OpenAI from "openai";

const origin = "https://api.openai.com";
const responseLimit = 256 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
export const interactiveActionSettings = Object.freeze({ executionMs: 30_000, maxOutputTokens: 4096, reasoningEffort: "low" });

export class InteractiveActionError extends Error {
  constructor(code) { super(code); this.name = "InteractiveActionError"; this.code = code; }
}
const fail = (code) => { throw new InteractiveActionError(code); };

// This client has one destination and explicit credentials. No environment
// defaults, retries, remote conversation, background run or agent session.
export function createInteractiveClient({ apiKey, requestTimeoutMs, fetcher = globalThis.fetch }) {
  return new OpenAI({
    apiKey, baseURL: `${origin}/v1`, organization: null, project: null,
    adminAPIKey: null, webhookSecret: null, maxRetries: 0,
    timeout: requestTimeoutMs, logLevel: "off",
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== origin || url.pathname !== "/v1/responses" || url.search || (init?.method ?? "GET") !== "POST") fail("unexpected_interactive_url");
      const response = await fetcher(input, { ...init, redirect: "error", headers: {
        Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json",
      } });
      if (Number(response.headers.get("content-length")) > responseLimit) {
        await response.body?.cancel();
        fail("interactive_response_too_large");
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > responseLimit) { await reader.cancel(); fail("interactive_response_too_large"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(size ? Buffer.concat(chunks, size) : null, { status: response.status, statusText: response.statusText, headers });
    },
  });
}

const safeCodes = new Set(["unknown_parameter", "invalid_request_error", "invalid_value", "invalid_type", "unsupported_value",
  "model_not_found", "model_not_supported", "invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "invalid_json_schema"]);
const safeTypes = new Set(["invalid_request_error", "authentication_error", "permission_error", "rate_limit_error", "server_error"]);
const safeParameters = new Set(["model", "reasoning", "reasoning.effort", "store", "input", "tools", "tools.0.parameters", "tool_choice", "max_output_tokens", "parallel_tool_calls"]);

function providerFailure(error) {
  if (error instanceof InteractiveActionError) return error;
  // The SDK wraps errors from its fetch adapter as connection failures.
  // Recover only our own fixed, redacted failures from that cause chain.
  let cause = error?.cause;
  for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause) {
    if (cause instanceof InteractiveActionError) return cause;
  }
  if (["invalid_assistant_plan", "invalid_assistant_sources", "unexpected_assistant_arguments", "invalid_repair_confirmation"].includes(error?.code ?? error?.message)) {
    return new InteractiveActionError(error.code ?? error.message);
  }
  const failure = new InteractiveActionError("interactive_provider_request_failed");
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) failure.http_status = error.status;
  if (safeCodes.has(error?.code)) failure.provider_error_code = error.code;
  if (safeTypes.has(error?.type)) failure.provider_error_type = error.type;
  if (safeParameters.has(error?.param)) failure.provider_parameter = error.param;
  return failure;
}

// A forced function call returns structured evidence only. The application
// independently validates intent, permission and task state before any effect.
export async function runInteractiveAction(input, options = {}, definition) {
  let prepared;
  let apiKey;
  let signal;
  let executionMs;
  let factory;
  let serialized;
  try {
    apiKey = input.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512 || /[\r\n]/u.test(apiKey)) throw new Error();
    if (input.model !== "gpt-6.1-sol") fail("explicit_sol_model_required");
    signal = input.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error();
    executionMs = options.executionMs ?? interactiveActionSettings.executionMs;
    factory = options.createClient ?? createInteractiveClient;
    if (!Number.isInteger(executionMs) || executionMs < 1 || executionMs > interactiveActionSettings.executionMs || typeof factory !== "function" ||
      (options.fetcher !== undefined && typeof options.fetcher !== "function")) throw new Error();
    prepared = definition.prepare(input);
    serialized = JSON.stringify(prepared.payload);
    if (typeof serialized !== "string" || serialized.length > 64_000) throw new Error();
    prepared = { ...prepared, history: structuredClone(prepared.history) };
  } catch (error) {
    if (error?.code) throw error;
    fail("invalid_interactive_configuration");
  }
  if (signal?.aborted) fail("interactive_action_aborted");
  const controller = new AbortController();
  let timer;
  let aborted;
  try {
    const stop = new Promise((resolve, reject) => {
      timer = setTimeout(() => { reject(new InteractiveActionError("interactive_action_timeout")); controller.abort(); }, executionMs);
      if (signal) {
        aborted = () => { reject(new InteractiveActionError("interactive_action_aborted")); controller.abort(); };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }
    });
    const response = await Promise.race([stop, Promise.resolve().then(() => {
      if (controller.signal.aborted) fail(signal?.aborted ? "interactive_action_aborted" : "interactive_action_timeout");
      const client = factory({ apiKey: apiKey.trim(), requestTimeoutMs: executionMs, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
      if (typeof client?.responses?.create !== "function") fail("responses_sdk_surface_unavailable");
      return client.responses.create({
        model: input.model, reasoning: { effort: interactiveActionSettings.reasoningEffort },
        store: false, instructions: definition.instructions, input: serialized,
        tools: [{ ...definition.tool, strict: true }],
        tool_choice: { type: "function", name: definition.tool.name }, parallel_tool_calls: false,
        max_output_tokens: interactiveActionSettings.maxOutputTokens, stream: false,
      }, { signal: controller.signal, timeout: executionMs, maxRetries: 0 });
    })]);
    if (signal?.aborted) fail("interactive_action_aborted");
    if (!response || typeof response.id !== "string" || !idPattern.test(response.id) || !/^gpt-6\.1-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(response.model ?? "") || response.status !== "completed" ||
      !Array.isArray(response.output) || !response.output.length || response.output.length > 16 ||
      response.output.some((item) => !["reasoning", "function_call"].includes(item?.type))) fail("invalid_interactive_response");
    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length !== 1) fail("invalid_interactive_action");
    const call = calls[0];
    if (call.name !== definition.tool.name || typeof call.call_id !== "string" || !idPattern.test(call.call_id) ||
      ![undefined, "completed"].includes(call.status) || call.async === true || (call.caller && call.caller.type !== "direct") ||
      (call.namespace !== undefined && call.namespace !== null) || typeof call.arguments !== "string" || call.arguments.length > 16_000) fail("invalid_interactive_action");
    let args;
    try { args = JSON.parse(call.arguments); } catch { fail("invalid_interactive_arguments"); }
    return definition.validate(args, prepared.history);
  } catch (error) {
    if (signal?.aborted) fail("interactive_action_aborted");
    throw providerFailure(error);
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}
