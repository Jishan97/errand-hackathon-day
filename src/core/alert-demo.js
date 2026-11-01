import { createHash } from 'node:crypto';
import prepared from '../assistant/prepared-upload-fix.js';

export const ALERT_SCOPE = 'upload-error-prepared-pr-and-call';
const receipt = /^[a-f0-9]{32}$/;
const sha = /^[a-f0-9]{40}$/;
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
    async accept(event) {
      if (!receipt.test(event?.eventId ?? '') || !sha.test(event?.details?.baseSha ?? '') || event.details.fixture !== 'upload_lf_v1') throw Error('invalid_alert_event');
      return call('accept', { p_receipt: event.eventId, p_base_sha: event.details.baseSha });
    },
    async status() {
      const result = await call('status', {});
      const safe = { status: result.status };
      if (result.phase !== undefined && ['waiting', 'queued', 'opening_pr', 'calling', 'completed', 'failed', 'unknown'].includes(result.phase)) safe.phase = result.phase;
      if (prUrl.test(result.pullRequest ?? '')) safe.pullRequest = result.pullRequest;
      if (result.callbackStatus === 'submitted_not_verified') safe.callbackStatus = result.callbackStatus;
      if (sha.test(result.baseSha ?? '')) safe.baseSha = result.baseSha;
      return safe;
    },
    async run(id) {
      if (!receipt.test(id ?? '')) throw Error('invalid_alert_event');
      const job = await call('claim', { p_receipt: id });
      if (job.status !== 'claimed') return job;
      let phase = 'preparing', pr = null;
      const record = (next, url = null) => call('record', { p_receipt: id, p_phase: next, p_pr: url });
      try {
        if (!sha.test(job.baseSha ?? '') || !/^[a-f0-9-]{36}$/.test(job.approvalId ?? '')) throw Error('invalid_alert_job');
        const files = preparedRepair(await github.snapshot(job.baseSha));
        phase = 'opening_pr';
        pr = await github.createPullRequest({ taskId: job.approvalId, baseSha: job.baseSha, files, prepared: true });
        if (!prUrl.test(pr?.pullRequest ?? '')) throw Error('incident_pr_unconfirmed');
        await record('calling', pr.pullRequest);
        phase = 'calling';
        const result = await caller.call({ signedAlert: true, baseSha: job.baseSha, pullRequest: pr.pullRequest });
        if (result.status !== 'submitted_not_verified') throw Error('callback_submission_unconfirmed');
        await record('completed', pr.pullRequest);
        return { status: 'completed', pullRequest: pr.pullRequest, callbackStatus: result.status };
      } catch {
        // No retries after a provider write: a lost response may hide success.
        await record(phase === 'preparing' ? 'failed' : 'unknown', prUrl.test(pr?.pullRequest ?? '') ? pr.pullRequest : null);
        return { status: phase === 'preparing' ? 'failed' : 'unknown' };
      }
    },
  });
}
