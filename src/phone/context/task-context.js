const purposes = new Set(["inbound", "decision", "completion", "worker"]);
const taskStates = new Set([
  "received", "working", "waiting_for_email", "needs_user", "awaiting_confirmation",
  "completed", "failed", "cancelled",
]);
const sourceTypes = new Set(["call", "transcript", "email"]);
const constraintKeys = new Set(["local_date", "start_strictly_after", "time_zone", "other_dates_require_approval"]);
const recordRepairConstraintKeys = new Set(["background_job", "email", "booking"]);
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;

class TaskContextError extends Error {
  constructor(code) {
    super(code);
    this.name = "TaskContextError";
    this.code = code;
  }
}

const fail = (code) => { throw new TaskContextError(code); };
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value) => typeof value === "string" && idPattern.test(value);
const text = (value, maximum) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const version = (value) => Number.isSafeInteger(value) && value >= 1;
const clockTime = (value, seconds = false) => typeof value === "string" && (
  seconds ? /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/ : /^(?:[01]\d|2[0-3]):[0-5]\d$/
).test(value);

function timestamp(value) {
  return typeof value === "string" && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function timeZone(value) {
  if (!text(value, 100)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}

function localDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function callingWindow(value) {
  if (value === null || value === undefined) return null;
  if (!record(value) || !clockTime(value.start_local) || !clockTime(value.end_local)) fail("invalid_context_data");
  return { startLocal: value.start_local, endLocal: value.end_local };
}

function constraints(value) {
  if (
    !record(value) || Object.keys(value).length !== constraintKeys.size || Object.keys(value).some((key) => !constraintKeys.has(key)) ||
    !localDate(value.local_date) || !clockTime(value.start_strictly_after, true) ||
    !timeZone(value.time_zone) || value.other_dates_require_approval !== true
  ) return null;
  return {
    localDate: value.local_date,
    startStrictlyAfter: value.start_strictly_after,
    timeZone: value.time_zone,
    otherDatesRequireApproval: true,
  };
}

function recordRepairConstraints(value) {
  if (
    !record(value) || Object.keys(value).length !== recordRepairConstraintKeys.size ||
    Object.keys(value).some((key) => !recordRepairConstraintKeys.has(key)) ||
    value.background_job !== "diagnostic_only" || value.email !== false || value.booking !== false
  ) return null;
  return { backgroundJob: "diagnostic_only", email: false, booking: false };
}

function approvalContext(raw, task, profile, contact, now) {
  if (raw !== null && raw !== undefined) {
    if (
      !record(raw) || !id(raw.id) || raw.task_id !== task.id || raw.resident_id !== profile.id ||
      raw.contact_id !== contact.id || raw.id !== task.current_approval_id
    ) fail("context_binding_mismatch");
  }
  if (task.current_approval_id === null || task.current_approval_id === undefined) {
    return { approval: null, reason: "not_granted" };
  }
  if (!id(task.current_approval_id)) fail("invalid_context_data");
  if (!raw) return { approval: null, reason: "missing" };
  if (raw.status === "revoked") return { approval: null, reason: "revoked" };
  if (raw.status === "expired") return { approval: null, reason: "expired" };
  if (raw.status !== "confirmed") return { approval: null, reason: "not_confirmed" };
  if (!version(raw.task_revision) || !version(raw.profile_version) || !version(raw.contact_version)) {
    return { approval: null, reason: "invalid" };
  }
  if (raw.task_revision !== task.revision || raw.profile_version !== profile.version || raw.contact_version !== contact.version) {
    return { approval: null, reason: "stale" };
  }
  if (raw.expires_at !== null && raw.expires_at !== undefined) {
    if (!timestamp(raw.expires_at)) return { approval: null, reason: "invalid" };
    if (Date.parse(raw.expires_at) <= now) return { approval: null, reason: "expired" };
  }
  const normalized = raw.scope === "record_repair_request"
    ? recordRepairConstraints(raw.constraints)
    : raw.scope === "negotiate_and_confirm_repair" ? constraints(raw.constraints) : null;
  if (
    !normalized || !text(raw.original_instruction, 2000) ||
    typeof raw.proposal_hash !== "string" || !/^[a-f0-9]{64}$/i.test(raw.proposal_hash)
  ) return { approval: null, reason: "invalid" };
  return {
    approval: {
      id: raw.id,
      status: "confirmed",
      scope: raw.scope,
      constraints: normalized,
      originalInstruction: raw.original_instruction,
      taskRevision: raw.task_revision,
      profileVersion: raw.profile_version,
      contactVersion: raw.contact_version,
      expiresAt: raw.expires_at ?? null,
    },
    reason: null,
  };
}

function summaryContext(raw, task, profile) {
  if (raw === null || raw === undefined) return null;
  if (!record(raw) || !id(raw.id) || raw.task_id !== task.id || raw.resident_id !== profile.id) {
    fail("context_binding_mismatch");
  }
  if (raw.task_revision !== task.revision) return null;
  if (
    !text(raw.summary, 2000) || !timestamp(raw.summary_created_at) || !Array.isArray(raw.summary_source_refs) ||
    raw.summary_source_refs.length < 1 || raw.summary_source_refs.length > 10
  ) return null;
  const refs = [];
  for (const ref of raw.summary_source_refs) {
    if (!record(ref) || !sourceTypes.has(ref.type) || !id(ref.id)) return null;
    refs.push({ type: ref.type, id: ref.id });
  }
  return {
    id: raw.id,
    authority: "derived_not_permission_or_completion_evidence",
    text: raw.summary,
    taskRevision: raw.task_revision,
    createdAt: raw.summary_created_at,
    sourceRefs: refs,
  };
}

function freeze(value) {
  if (record(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// The repository supplies one ownership-scoped database snapshot. Recheck it even
// when its server credential bypasses RLS, and never return arbitrary row fields.
export async function buildTaskContext(input = {}, options = {}) {
  try {
    const { repository, verifiedResidentId, taskId, purpose } = input ?? {};
    const { now = Date.now } = options ?? {};
    if (
      !id(verifiedResidentId) || !id(taskId) || !purposes.has(purpose) ||
      typeof repository?.getTaskContextSnapshot !== "function" || typeof repository?.recordContextManifest !== "function" ||
      typeof now !== "function"
    ) fail("invalid_context_request");
    const currentTime = now();
    if (!Number.isFinite(currentTime)) fail("invalid_context_request");
    let snapshot;
    try { snapshot = await repository.getTaskContextSnapshot({ verifiedResidentId, taskId }); }
    catch { fail("context_snapshot_unavailable"); }
    if (!record(snapshot) || !record(snapshot.profile) || !record(snapshot.contact) || !record(snapshot.task)) {
      fail("context_record_missing");
    }
    const { profile, contact, task } = snapshot;
    if (
      profile.id !== verifiedResidentId || task.id !== taskId || task.resident_id !== verifiedResidentId ||
      contact.resident_id !== verifiedResidentId || !id(contact.id) || task.contact_id !== contact.id
    ) fail("context_binding_mismatch");
    if (
      !text(profile.preferred_name, 80) || !timeZone(profile.time_zone) || !text(profile.language, 100) ||
      !["slow", "normal", "fast"].includes(profile.speaking_pace) || typeof profile.repetition_preference !== "boolean" ||
      typeof profile.callback_consent !== "boolean" || !version(profile.version) || !timestamp(profile.confirmed_at) ||
      !text(contact.display_name, 80) || contact.role !== "landlord" || !version(contact.version) ||
      !timestamp(contact.confirmed_at) || contact.disabled_at !== null ||
      !text(task.request, 2000) || !taskStates.has(task.status) || !version(task.revision)
    ) fail("invalid_context_data");

    const residentProfile = {
      id: profile.id,
      preferredName: profile.preferred_name,
      timeZone: profile.time_zone,
      language: profile.language,
      speakingPace: profile.speaking_pace,
      repetitionPreference: profile.repetition_preference,
      callbackConsent: profile.callback_consent,
      callingWindow: callingWindow(profile.calling_window),
      version: profile.version,
    };
    const selected = approvalContext(snapshot.approval, task, profile, contact, currentTime);
    const conversationSummary = summaryContext(snapshot.summary, task, profile);
    const manifest = freeze({
      schemaVersion: 1,
      residentId: verifiedResidentId,
      taskId: task.id,
      profileVersion: profile.version,
      contactId: contact.id,
      contactVersion: contact.version,
      taskRevision: task.revision,
      approvalId: selected.approval?.id ?? null,
      summaryId: conversationSummary?.id ?? null,
      sourceRefs: conversationSummary?.sourceRefs.map((ref) => ({ ...ref })) ?? [],
    });
    const context = freeze({
      purpose,
      residentProfile,
      contact: { id: contact.id, displayName: contact.display_name, role: contact.role, version: contact.version },
      task: { id: task.id, request: task.request, status: task.status, revision: task.revision, stateSource: "authoritative_task_record" },
      approval: selected.approval,
      approvalUnavailableReason: selected.reason,
      conversationSummary,
      verifiedOutcome: null,
      manifest,
    });
    try { await repository.recordContextManifest({ verifiedResidentId, taskId, manifest, purpose }); }
    catch { fail("context_manifest_not_recorded"); }
    return context;
  } catch (error) {
    if (error instanceof TaskContextError) throw error;
    fail("invalid_context_data");
  }
}
