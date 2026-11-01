import { placeTestCall } from "../voice/twilio.js";

export function createAssistantWorker({ config, repository, developer = null, placeCall = placeTestCall, logger = () => {} }) {
  return Object.freeze({
    async run(token = null) {
      const job = await repository.claim(token);
      if (job.status !== "claimed") return { status: job.status };
      let effectStarted = false;
      let result;
      let callSid = null;
      try {
        if (["callback", "result_callback"].includes(job.operation)) {
          effectStarted = true;
          const call = await placeCall(config, { jobId: job.id });
          callSid = call.call_sid;
          result = { outcome: "call_submitted", delivery: "not_yet_verified" };
        } else {
          if (!developer?.enabled) throw new Error("developer_unavailable");
          if (job.operation === "developer_check") result = await developer.inspect();
          else if (job.operation === "developer_recover") {
            effectStarted = true;
            result = await developer.recover(job.args.snapshot, job.id);
          } else throw new Error("unsupported_job");
        }
        await repository.finish(job, "done", result, callSid);
        logger({ level: "info", event: "assistant_job_finished", operation: job.operation, status: "done" });
        return { status: "processed", operation: job.operation };
      } catch {
        // A timeout or partial recovery may already have made an external effect.
        // Persist uncertainty and never automatically retry that effect.
        const status = effectStarted ? "unknown" : "failed";
        await repository.finish(job, status, { outcome: status }).catch(() => {});
        logger({ level: "warn", event: "assistant_job_finished", operation: job.operation, status });
        return { status, operation: job.operation };
      }
    },
  });
}
