import { createHash } from "node:crypto";

export const operations = Object.freeze(["schedule_callback", "reschedule_callback", "cancel_task", "complete_task", "save_note", "developer_check", "developer_recover", "incident_fix", "generate_image"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (id) => typeof id === "string" && uuid.test(id);
export const text = (value, max = 240) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

export function validateAction(operation, input, { now = Date.now(), developerEnabled = false, incidentEnabled = false, imageEnabled = false } = {}) {
  if (!operations.includes(operation) || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_action");
  const allowed = ["taskId", "revision", "title", "dueAt"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("invalid_action_arguments");
  const args = {};
  if (["reschedule_callback", "cancel_task", "complete_task", "incident_fix"].includes(operation)) {
    if (!isId(input.taskId) || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("task_revision_required");
    args.taskId = input.taskId; args.revision = input.revision;
  } else if (input.taskId != null || input.revision != null) throw new Error("unexpected_task_target");
  if (["schedule_callback", "reschedule_callback"].includes(operation)) {
    if (typeof input.dueAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.dueAt)) throw new Error("explicit_callback_time_required");
    const due = Date.parse(input.dueAt);
    if (!Number.isFinite(due) || due < now + 10_000 || due > now + 30 * 86400_000) throw new Error("callback_time_out_of_range");
    args.dueAt = new Date(due).toISOString();
  } else if (input.dueAt != null) throw new Error("unexpected_callback_time");
  if (["schedule_callback", "reschedule_callback", "save_note", "generate_image"].includes(operation)) {
    if (!text(input.title, 160)) throw new Error("action_title_required");
    args.title = input.title.trim();
  } else if (input.title != null) throw new Error("unexpected_action_title");
  if (operation.startsWith("developer_") && !developerEnabled) throw new Error("developer_tools_unavailable");
  if (operation === "incident_fix" && !incidentEnabled) throw new Error("incident_tools_unavailable");
  if (operation === 'generate_image' && !imageEnabled) throw new Error('image_tools_unavailable');
  return Object.freeze(args);
}

export function describeAction(operation, args, { timeZone = "Europe/London", repository = null } = {}) {
  const when = args.dueAt ? new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short", hour12: true }).format(new Date(args.dueAt)) : null;
  const descriptions = {
    generate_image: `Generate one picture of: ${args.title}. Show it on the operator's demo web screen.`,
    schedule_callback: `Call you on ${when} (${timeZone}) about: ${args.title}.`,
    reschedule_callback: `Move that callback to ${when} (${timeZone}) about: ${args.title}.`,
    cancel_task: "Cancel that task and its queued work.",
    complete_task: "Mark that task done and stop its queued callbacks.",
    save_note: `Save this note: ${args.title}.`,
    developer_check: `Check the prepared demo in ${repository} and call you with the findings.`,
    developer_recover: `Restore the prepared demo in ${repository}, verify recovery and open a fix pull request for review. Leave the fix unmerged.`,
    incident_fix: `Fix the reported fictional upload issue in ${repository}, run regression tests, open a pull request and merge only if its checks pass and the approved code is unchanged. Let Vercel deploy it, repeat the sample upload and call you back with the result.`,
  };
  return descriptions[operation];
}

export const actionHash = (operation, args, summary) => createHash("sha256").update(JSON.stringify({ operation, args, summary })).digest("hex");
