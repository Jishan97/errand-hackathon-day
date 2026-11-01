import { createHash } from 'node:crypto';
import prepared from '../assistant/prepared-upload-fix.js';

export const ALERT_SCOPE = 'upload-error-prepared-pr-and-call';
const receipt = /^[a-f0-9]{32}$/;
const sha = /^[a-f0-9]{40}$/;
const failureReasons = new Set(['source_changed','pr_changed','github_unavailable','call_unconfirmed','storage_unconfirmed','preparation_failed']);
function failureReason(error) {
  const code = error?.message;
  if (['prepared_source_changed','incident_base_changed','incident_ci_definition_changed'].includes(code)) return 'source_changed';
  if (['incident_pr_changed','incident_patch_changed','incident_pr_unconfirmed'].includes(code)) return 'pr_changed';
  if (typeof code === 'string' && (code.startsWith('github_') || code.startsWith('incident_github_'))) return 'github_unavailable';
  if (typeof code === 'string' && code.startsWith('callback_')) return 'call_unconfirmed';
  if (typeof code === 'string' && (code.startsWith('fast_storage_') || code.startsWith('alert_storage_'))) return 'storage_unconfirmed';
  return 'preparation_failed';
}
const prUrl = /^https:\/\/github\.com\/Jishan97\/errand-agent-demo\/pull\/[1-9]\d*$/;

export function preparedRepair(snapshot) {
  if (!sha.test(snapshot?.baseSha ?? '') || !Array.isArray(snapshot.files) || snapshot.files.length !== 4) throw Error('prepared_source_changed');
  for (const [path, digest] of Object.entries(prepared.sourceHashes)) {
    const matches = snapshot.files.filter(file => file.path === path);
    if (matches.length !== 1 || typeof matches[0].content !== 'string' ||
      createHash('sha256').update(matches[0].content).digest('hex') !== digest) throw Error('prepared_source_changed');
  }
  return structuredClone(prepared.files);
}

export function createAlertDemo({ rpc, github, caller }) {
  const call = async (name, params) => {
    const result = await rpc(`errand_alert_${name}`, params);
    if (!result || typeof result !== 'object' || typeof result.status !== 'string') throw Error('alert_storage_unconfirmed');
    return result;
  };
  return Object.freeze({
    async prepare() {
      const baseSha = await github.currentHead();
      preparedRepair(await github.snapshot(baseSha));
      return { baseSha, scope: ALERT_SCOPE, repository: 'Jishan97/errand-agent-demo' };
    },
    async arm(baseSha, scope) {
      if (!sha.test(baseSha ?? '') || scope !== ALERT_SCOPE) throw Error('invalid_alert_approval');
      preparedRepair(await github.snapshot(baseSha));
      return call('arm', { p_base_sha: baseSha });
    },
    async accept(event, capture = {}) {
      if (!receipt.test(event?.eventId ?? '') || !sha.test(event?.details?.baseSha ?? '') || event.details.fixture !== 'upload_lf_v1') throw Error('invalid_alert_event');
      const fresh = receipt.test(capture.captureId ?? '') && typeof capture.occurredAt === 'string' && Number.isFinite(Date.parse(capture.occurredAt));
      const id = fresh ? createHash('sha256').update(`${event.project}:${capture.captureId}:${event.details.baseSha}`).digest('hex').slice(0,32) : event.eventId;
      const result = await call(fresh ? 'accept_capture' : 'accept', {
        p_receipt: id, p_base_sha: event.details.baseSha, ...(fresh ? {p_occurred_at: capture.occurredAt} : {}),
      });
      // The public intake receipt remains issue/release bound; the internal
      // recording job is independently deduplicated by the actual capture ID.
      return { status: result.status, receiptId: event.eventId, jobReceiptId: id };
    },
    async status() {
      const result = await call('status', {});
      const safe = { status: result.status };
      if (result.phase !== undefined && ['waiting', 'queued', 'opening_pr', 'calling', 'completed', 'failed', 'unknown'].includes(result.phase)) safe.phase = result.phase;
      if (prUrl.test(result.pullRequest ?? '')) safe.pullRequest = result.pullRequest;
      if (result.callbackStatus === 'submitted_not_verified') safe.callbackStatus = result.callbackStatus;
      if (sha.test(result.baseSha ?? '')) safe.baseSha = result.baseSha;
      if (failureReasons.has(result.failureReason)) safe.failureReason = result.failureReason;
      return safe;
    },
    async run(id) {
      if (!receipt.test(id ?? '')) throw Error('invalid_alert_event');
      const job = await call('claim', { p_receipt: id });
      if (job.status !== 'claimed') return job;
      let phase = 'preparing', pr = prUrl.test(job.reusePr ?? '') ? {pullRequest: job.reusePr} : null;
      const record = (next, url = null) => call('record', { p_receipt: id, p_phase: next, p_pr: url });
      try {
        if (!sha.test(job.baseSha ?? '') || !/^[a-f0-9-]{36}$/.test(job.approvalId ?? '')) throw Error('invalid_alert_job');
        const files = preparedRepair(await github.snapshot(job.baseSha));
        if (job.reusePr) {
          pr = await github.verifyPreparedPullRequest({ pullRequest: job.reusePr, headSha: job.prHead, baseSha: job.baseSha, files });
          if (!['open','closed'].includes(pr?.status)) throw Error('incident_pr_unconfirmed');
          if (pr.status === 'closed') {
            // Only a verified, unmerged closed PR can be replaced. The worker's
            // one-time claim makes a duplicate Sentry delivery a no-op.
            phase = 'opening_pr';
            const replacement = await github.createPullRequest({ taskId: job.approvalId, baseSha: job.baseSha, files, prepared: true });
            if (!prUrl.test(replacement?.pullRequest ?? '') || !sha.test(replacement?.headSha ?? '')) throw Error('incident_pr_unconfirmed');
            const saved = await call('replace_pr', {p_receipt:id, p_previous_pr:job.reusePr, p_previous_head:job.prHead, p_pr:replacement.pullRequest, p_head:replacement.headSha});
            if (saved.status !== 'recorded') throw Error('alert_storage_unconfirmed');
            pr = replacement;
          }
        } else {
          phase = 'opening_pr';
          pr = await github.createPullRequest({ taskId: job.approvalId, baseSha: job.baseSha, files, prepared: true });
        }
        if (!prUrl.test(pr?.pullRequest ?? '')) throw Error('incident_pr_unconfirmed');
        await record('calling', pr.pullRequest);
        phase = 'calling';
        const result = await caller.call({ signedAlert: true, baseSha: job.baseSha, pullRequest: pr.pullRequest });
        if (result.status !== 'submitted_not_verified') throw Error('callback_submission_unconfirmed');
        await record('completed', pr.pullRequest);
        return { status: 'completed', pullRequest: pr.pullRequest, callbackStatus: result.status };
      } catch (error) {
        // Store only a fixed reason; provider bodies and secrets never enter status.
        // A lost response after a provider write still requires reconciliation.
        const uncertain = phase !== 'preparing';
        const reason = failureReason(error);
        await call('fail', {p_receipt:id, p_uncertain:uncertain, p_reason:reason});
        return { status: uncertain ? 'unknown' : 'failed', failureReason:reason };
      }
    },
  });
}
