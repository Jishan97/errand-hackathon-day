// Explicit server-only configuration. This module never reads dotenv files or
// process.env, and is deliberately not connected to the phone runtime yet.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const purposes = new Set(["inbound", "decision", "completion", "worker"]);
const rpcNames = new Set([
  "errand_get_task_context", "errand_record_context_manifest", "errand_begin_call",
  "errand_authenticate_call", "errand_get_verified_call", "errand_issue_stream", "errand_consume_stream", "errand_identity_ready",
  "errand_stage_intake", "errand_review_intake", "errand_confirm_intake", "errand_discard_intake", "errand_run_diagnostic_job",
  "errand_stage_repair_proposal", "errand_arm_repair_proposal", "errand_confirm_repair_proposal", "errand_discard_repair_proposal",
  "errand_confirm_spoken_repair_proposal",
  "errand_assistant_context", "errand_assistant_stage", "errand_assistant_confirm", "errand_assistant_decline",
  "errand_phone_claim", "errand_assistant_claim", "errand_assistant_finish", "errand_assistant_status",
  "errand_assistant_start_demo",
  "errand_assistant_bind_callback",
  "errand_github_connection_get", "errand_github_connection_save", "errand_github_connection_disconnect",
  "errand_incident_accept_event", "errand_incident_claim", "errand_incident_advance", "errand_incident_stage",
  "errand_incident_confirm", "errand_incident_decline", "errand_incident_context", "errand_incident_status",
]);

export class StorageError extends Error {
  constructor(code) {
    super(code);
    this.name = "StorageError";
    this.code = code;
  }
}

function requireId(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new StorageError("invalid_context_binding");
  return value;
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new StorageError("invalid_context_binding");
  return value;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new StorageError("storage_response_too_large");
      chunks.push(value);
    }
    if (!length) return null;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createServerRpcClient({ supabaseUrl, secretKey, fetcher = globalThis.fetch, timeoutMs = 10_000 }) {
  let origin;
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
      || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch {
    throw new StorageError("canonical_supabase_url_required");
  }
  // New secret keys go only in apikey; they are not JWT Bearer tokens.
  if (typeof secretKey !== "string" || !/^sb_secret_[A-Za-z0-9_-]{20,200}$/.test(secretKey)) {
    throw new StorageError("server_secret_key_required");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new StorageError("invalid_storage_timeout");
  }

  async function rpc(name, parameters) {
    if (!rpcNames.has(name)) throw new StorageError("unknown_storage_operation");
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(`${origin}/rest/v1/rpc/${name}`, {
            method: "POST", redirect: "error", signal: controller.signal,
            headers: { apikey: secretKey, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(parameters),
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new StorageError("storage_request_rejected");
          }
          return await readJson(response);
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new StorageError("storage_request_timed_out"));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // Provider errors may include request bodies, personal data or credentials.
      throw new StorageError("storage_request_failed");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return rpc;
}

export function createContextRepository(options) {
  const rpc = createServerRpcClient(options);
  return Object.freeze({
    async getTaskContextSnapshot({ verifiedResidentId, taskId }) {
      const result = await rpc("errand_get_task_context", {
        p_resident_id: requireId(verifiedResidentId), p_task_id: requireId(taskId),
      });
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new StorageError("invalid_storage_response");
      return result;
    },
    async recordContextManifest({ verifiedResidentId, taskId, manifest, purpose }) {
      if (!manifest || manifest.schemaVersion !== 1 || manifest.residentId !== verifiedResidentId || manifest.taskId !== taskId
        || !purposes.has(purpose)) throw new StorageError("invalid_context_binding");
      requireId(manifest.contactId);
      await rpc("errand_record_context_manifest", {
        p_resident_id: requireId(verifiedResidentId), p_task_id: requireId(taskId),
        p_profile_version: requireVersion(manifest.profileVersion),
        p_contact_version: requireVersion(manifest.contactVersion),
        p_task_revision: requireVersion(manifest.taskRevision),
        p_approval_id: manifest.approvalId === null ? null : requireId(manifest.approvalId),
        p_summary_id: manifest.summaryId === null ? null : requireId(manifest.summaryId),
        p_purpose: purpose,
      });
    },
  });
}
