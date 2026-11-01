import { randomUUID } from "node:crypto";
import { planAssistantTurn } from "../agents/assistant-turn.js";
import { assessActionConfirmation } from "../agents/repair-proposal.js";
import { actionHash, describeAction, validateAction, isId } from "./tools.js";

export function createAssistantService({ config, repository, developer = null, incidents = null, planner = planAssistantTurn, assessor = assessActionConfirmation }) {
  return Object.freeze({
    async context(callSid) {
      const context = await (incidents ? incidents.context(callSid) : repository.context(callSid));
      if (!context.profile || !Array.isArray(context.tasks) || context.tasks.length > 16) throw new Error("invalid_assistant_context");
      const developerAvailable = developer?.enabled && (typeof developer.isAvailable === "function" ? await Promise.resolve().then(() => developer.isAvailable()).catch(() => false) : true);
      return { ...context, capabilities: ["schedule_callback", "reschedule_callback", "cancel_task", "complete_task", "save_note",
        ...(developerAvailable ? ["developer_check", "developer_recover"] : []),
        ...(incidents && developerAvailable && context.tasks.some((task) => task.incident?.phase === "awaiting_approval") ? ["incident_fix"] : [])],
      developerRepository: developerAvailable ? developer.repository : null };
    },
    async plan({ callSid, history, pending, signal, isCurrent = () => true }) {
      const context = await this.context(callSid);
      const plan = await planner({ apiKey: config.values.OPENAI_API_KEY, model: config.agentModel, history, context,
        pending: pending ? { operation: pending.operation, summary: pending.summary } : null, signal });
      if (signal?.aborted || !isCurrent()) throw new Error("assistant_turn_superseded");
      if (plan.kind !== "propose") return { ...plan, context };
      const args = validateAction(plan.operation, plan.args, { developerEnabled: context.capabilities.includes("developer_check"), incidentEnabled: context.capabilities.includes("incident_fix") });
      if (args.taskId && !context.tasks.some((task) => task.id === args.taskId && task.revision === args.revision)) throw new Error("stale_task_selection");
      const incidentTarget = args.taskId ? context.tasks.find((task) => task.id === args.taskId)?.incident : null;
      if (incidentTarget && plan.operation !== "incident_fix") return { kind: "reply", context,
        reply: incidentTarget.phase === "awaiting_approval"
          ? "That upload fix has not started. It will stay waiting unless you approve its scope. I have not changed the incident."
          : "Voice cancellation or rescheduling of an incident repair is not implemented in this prototype. I have not changed it. You can check its progress on the status page." };
      if (plan.operation === "incident_fix" && !context.tasks.some((task) => task.id === args.taskId && task.incident?.phase === "awaiting_approval")) throw new Error("incident_not_awaiting_approval");
      // The model cannot choose repository, file, code, branch or rollback SHA.
      const snapshot = plan.operation === "developer_recover" ? await developer.snapshot() : null;
      if (snapshot && !snapshot.broken) return { kind: "reply", reply: "The demo configuration is already enabled, so no recovery action was proposed. We can inspect the deployed site instead.", context };
      const effectiveArgs = snapshot ? { ...args, snapshot } : args;
      if (signal?.aborted || !isCurrent()) throw new Error("assistant_turn_superseded");
      const summary = describeAction(plan.operation, args, { timeZone: context.profile.timeZone, repository: developer?.repository });
      const hash = actionHash(plan.operation, effectiveArgs, summary);
      const nonce = randomUUID();
      const staged = plan.operation === "incident_fix"
        ? await incidents.stage({ callSid, taskId: args.taskId, revision: args.revision, summary, hash, nonce, sourceEventIds: plan.sourceEventIds })
        : await repository.stage({ callSid, operation: plan.operation, args: effectiveArgs, summary, hash, nonce, sourceEventIds: plan.sourceEventIds });
      if (!isId(staged.id) || staged.hash !== hash || staged.nonce !== nonce || staged.summary !== summary) throw new Error("proposal_binding_failed");
      return { kind: "propose", context, proposal: Object.freeze({ ...staged, operation: plan.operation, args: effectiveArgs }) };
    },
    async confirm({ callSid, proposal, readbackText, replyHistory, signal, isCurrent, waitForReady = async () => true }) {
      if (typeof readbackText !== "string" || !readbackText.trim()) throw new Error("delivered_readback_required");
      const assessment = await assessor({ apiKey: config.values.OPENAI_API_KEY, model: config.agentModel,
        proposalSummary: proposal.summary, readbackText, replyHistory, signal });
      if (signal?.aborted || !isCurrent()) return { status: "stale" };
      if (assessment.decision !== "confirm") return { status: assessment.decision, question: assessment.clarificationQuestion };
      // Keep a read-only verdict while raw activity settles. New caller text,
      // changed readback or closure still invalidates the captured evidence.
      const ready = await waitForReady();
      if (signal?.aborted || !isCurrent()) return { status: "stale" };
      if (!ready) return { status: "not_ready" };
      // Consume the exact issued snapshot immediately before the atomic commit.
      if (!isCurrent(true)) return { status: "stale" };
      const store = proposal.operation === "incident_fix" ? incidents : repository;
      if (!store) throw Error("incident_tools_unavailable");
      const result = await store.confirm({ callSid, proposal, sourceEventIds: assessment.sourceEventIds });
      if (!["confirmed", "already_confirmed"].includes(result.status) || !isId(result.taskId)) throw new Error("confirmation_outcome_unknown");
      return { status: "confirmed", taskId: result.taskId, taskStatus: result.taskStatus };
    },
    decline: (callSid, proposalId, operation = null) => operation === "incident_fix" ? incidents.decline(callSid, proposalId) : repository.decline(callSid, proposalId),
    status: () => repository.status(),
    async developerStatus() {
      const enabled = Boolean(developer?.enabled && (typeof developer.isAvailable === "function" ? await Promise.resolve().then(() => developer.isAvailable()).catch(() => false) : true));
      return { enabled, repository: developer?.repository ?? null, credentialSource: developer?.credentialSource ?? "personal_token" };
    },
    bindCallback: (callSid, jobId) => repository.bindCallback(callSid, jobId),
    async startDemo() {
      if (!developer?.enabled || (typeof developer.isAvailable === "function" && !await developer.isAvailable())) throw new Error("developer_tools_unavailable");
      return repository.startDemo();
    },
  });
}
