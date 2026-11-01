import { isId } from "../assistant/tools.js";

export function createAssistantRepository({ rpc, callbacksOnly = false }) {
  const request = async (name, args) => {
    const value = await rpc(name, args);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_assistant_storage_response");
    return value;
  };
  return Object.freeze({
    context: (callSid) => request("errand_assistant_context", { p_provider_call_id: callSid }),
    stage: ({ callSid, operation, args, summary, hash, nonce, sourceEventIds }) => request("errand_assistant_stage", {
      p_provider_call_id: callSid, p_operation: operation, p_arguments: args, p_summary: summary,
      p_hash: hash, p_nonce: nonce, p_sources: sourceEventIds,
    }),
    confirm: ({ callSid, proposal, sourceEventIds }) => request("errand_assistant_confirm", {
      p_provider_call_id: callSid, p_proposal_id: proposal.id, p_hash: proposal.hash,
      p_nonce: proposal.nonce, p_confirmation_sources: sourceEventIds,
    }),
    decline: (callSid, proposalId) => request("errand_assistant_decline", { p_provider_call_id: callSid, p_proposal_id: proposalId }),
    async claim(token = null) {
      const result = await request(callbacksOnly ? "errand_phone_claim" : "errand_assistant_claim", { p_worker_token: token });
      if (!["empty", "ignored", "claimed"].includes(result.status) || (result.status === "claimed" &&
        (![result.id, result.taskId, result.residentId, result.lease].every(isId) ||
          !["callback", "result_callback", "developer_check", "developer_recover"].includes(result.operation)))) throw new Error("invalid_job_claim");
      return result;
    },
    finish: (job, status, result, callSid = null) => request("errand_assistant_finish", {
      p_job_id: job.id, p_lease: job.lease, p_status: status, p_result: result, p_call_sid: callSid,
    }),
    status: () => request("errand_assistant_status", {}),
    startDemo: () => request("errand_assistant_start_demo", {}),
    bindCallback: (callSid, jobId) => request("errand_assistant_bind_callback", { p_provider_call_id: callSid, p_job_id: jobId }),
  });
}
