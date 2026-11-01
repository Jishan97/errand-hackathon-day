const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callPattern = /^CA[0-9a-fA-F]{32}$/;
const streamPattern = /^MZ[0-9a-fA-F]{32}$/;
const directions = new Set(["inbound", "outbound"]);

export class IdentityRepositoryError extends Error {
  constructor(code) {
    super(code);
    this.name = "IdentityRepositoryError";
    this.code = code;
  }
}

function field(record, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function identifier(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error();
  return value;
}

function direction(value) {
  if (!directions.has(value)) throw new Error();
  return value;
}

function commonResponse(result) {
  return {
    call_id: identifier(field(result, "call_id"), uuidPattern),
    resident_id: identifier(field(result, "resident_id"), uuidPattern),
  };
}

function challengeResponse(result) {
  const common = commonResponse(result);
  const challengeId = field(result, "challenge_id");
  const attemptsLeft = field(result, "attempts_left");
  const verified = field(result, "verified");
  if (typeof verified !== "boolean" || !Number.isSafeInteger(attemptsLeft) || attemptsLeft < 0 || attemptsLeft > 3) throw new Error();
  if (challengeId !== null) identifier(challengeId, uuidPattern);
  return Object.freeze({ ...common, challenge_id: challengeId, attempts_left: attemptsLeft, verified });
}

function bindingResponse(result) {
  const common = commonResponse(result);
  const taskId = field(result, "task_id");
  if (taskId !== null) identifier(taskId, uuidPattern);
  return Object.freeze({ ...common, task_id: taskId, direction: direction(field(result, "direction")) });
}

/** Fixed server-only RPC adapter. It never receives PINs or reads configuration. */
export function createIdentityRepository(options) {
  let rpc;
  try {
    rpc = field(options, "rpc");
    if (typeof rpc !== "function") throw new Error();
  } catch {
    throw new IdentityRepositoryError("invalid_identity_repository");
  }

  async function request(name, input, parameters, response) {
    let args;
    try {
      args = parameters(input);
    } catch {
      throw new IdentityRepositoryError("invalid_identity_binding");
    }
    let result;
    try {
      // Exactly one attempt: callers must not retry an unknown mutation outcome.
      result = await rpc(name, args);
    } catch {
      throw new IdentityRepositoryError("identity_request_failed");
    }
    try {
      // Keep the database's snake_case contract, excluding unknown private fields.
      return response(result);
    } catch {
      throw new IdentityRepositoryError("invalid_identity_response");
    }
  }

  const providerCallId = (input) => identifier(field(input, "callSid"), callPattern);
  const nonce = (input) => identifier(field(input, "nonce"), uuidPattern);

  return Object.freeze({
    async admitDemoCall(input) {
      // Called only after the server validates the provider signature, account,
      // configured numbers and direction. This attests number-only demo
      // admission; it does not compare a caller-supplied code or boolean.
      let parameters;
      try {
        parameters = { p_provider_call_id: providerCallId(input), p_direction: direction(field(input, "direction")) };
      } catch { throw new IdentityRepositoryError("invalid_identity_binding"); }
      const initial = await request("errand_begin_call", parameters, (value) => value, challengeResponse);
      let admitted = initial;
      if (!initial.verified) {
        if (!initial.attempts_left || !initial.challenge_id) throw new IdentityRepositoryError("demo_call_admission_unavailable");
        admitted = await request("errand_authenticate_call", {}, () => ({
          p_provider_call_id: parameters.p_provider_call_id, p_challenge_id: initial.challenge_id, p_matched: true,
        }), challengeResponse);
      }
      if (!admitted.verified || admitted.call_id !== initial.call_id || admitted.resident_id !== initial.resident_id) {
        throw new IdentityRepositoryError("demo_call_admission_unavailable");
      }
      return Object.freeze({ call_id: admitted.call_id, resident_id: admitted.resident_id,
        admitted: true, admission_method: "allowed_test_number" });
    },
    checkStorage() {
      return request("errand_identity_ready", {}, () => ({}), (result) => {
        if (field(result, "ready") !== true || field(result, "scope") !== "fictional_identity_context_only") throw new Error();
        return Object.freeze({ ready: true, scope: "fictional_identity_context_only" });
      });
    },
    beginCall(input) {
      return request("errand_begin_call", input, (value) => ({
        p_provider_call_id: providerCallId(value), p_direction: direction(field(value, "direction")),
      }), challengeResponse);
    },
    authenticateCall(input) {
      return request("errand_authenticate_call", input, (value) => {
        const matched = field(value, "matched");
        if (typeof matched !== "boolean") throw new Error();
        return {
          p_provider_call_id: providerCallId(value),
          p_challenge_id: identifier(field(value, "challengeId"), uuidPattern), p_matched: matched,
        };
      }, challengeResponse);
    },
    getVerifiedCall(input) {
      return request("errand_get_verified_call", input, (value) => ({
        p_provider_call_id: providerCallId(value),
      }), bindingResponse);
    },
    issueStream(input) {
      return request("errand_issue_stream", input, (value) => ({
        p_provider_call_id: providerCallId(value), p_nonce: nonce(value),
      }), bindingResponse);
    },
    consumeStream(input) {
      return request("errand_consume_stream", input, (value) => ({
        p_provider_call_id: providerCallId(value), p_nonce: nonce(value),
        p_provider_stream_id: identifier(field(value, "streamSid"), streamPattern),
      }), bindingResponse);
    },
  });
}
