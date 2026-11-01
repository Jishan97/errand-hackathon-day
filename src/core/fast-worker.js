// A bounded driver around durable claims. Provider writes are never retried
// after an uncertain response; the saved lease quarantines interrupted writes.
const writePhases = new Set(['repair_start', 'create_pr', 'merge', 'callback']);
const terminal = new Set(['completed', 'failed', 'unknown']);
export const REPAIR_SCOPE = 'upload-parser-fix-test-pr-merge-replay-callback';

export function createFastWorker({ store, github, runner, caller, clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger = () => {} }) {
  async function step(job, markMutation) {
    let state = { ...job.state };
    const progress = (phase, additions = {}) => ({ phase, state: { ...state, ...additions } });
    if (job.approval?.baseSha !== job.event.details.baseSha || job.approval?.scope !== REPAIR_SCOPE) {
      throw Error('approval_binding_failed');
    }
    const baseSha = job.approval.baseSha;
    switch (job.phase) {
      case 'repair_start': {
        const snapshot = await github.snapshot(baseSha);
        markMutation();
        const handle = await runner.startApprovedRepair(snapshot, job.approval);
        return progress('repair_poll', { handle, startedAt: clock() });
      }
      case 'repair_poll': {
        const result = await runner.poll(state.handle);
        if (result.status === 'pending') return progress('repair_poll', { handle: result });
        const e = result.evidence;
        if (result.status !== 'completed' || !e?.reproduced || !e.fixed || !e.regressionTestExecuted ||
            !e.artifactsVerified || !e.readOnlyFilesUnchanged || e.afterExitCode !== 0 || e.baseSha !== baseSha) {
          throw Error('repair_evidence_missing');
        }
        return progress('cleanup', { handle: result, evidence: e, files: result.files, testsPassed: true });
      }
      case 'cleanup': {
        const result = await runner.cleanup(state.handle);
        if (result.status === 'pending') return progress('cleanup');
        if (!['deleted', 'not_found'].includes(result.status) || result.apiRemovalAcknowledged !== true) {
          throw Error('cleanup_unconfirmed');
        }
        return progress('create_pr', { handle: null, cleanupVerified: true });
      }
      case 'create_pr': {
        if (!state.testsPassed || !state.cleanupVerified) throw Error('tests_required');
        markMutation();
        const pr = await github.createPullRequest({ taskId: job.approval.id, baseSha, files: state.files });
        return progress('ci_wait', { pr, files: null });
      }
      case 'ci_wait': {
        const result = await github.checks(state.pr);
        if (result.status === 'pending') return progress('ci_wait');
        if (result.status !== 'passed') throw Error('ci_failed');
        return progress('merge', { ciPassed: true });
      }
      case 'merge': {
        if (!state.testsPassed || !state.ciPassed) throw Error('merge_evidence_required');
        markMutation();
        const merged = await github.merge(state.pr);
        return progress('deployment_wait', { mergeCommit: merged.mergeSha });
      }
      case 'deployment_wait': {
        const merged = await github.confirmMerged(state.pr, state.mergeCommit);
        if (merged.status === 'pending') return progress('deployment_wait');
        if (merged.status !== 'passed') throw Error('merge_confirmation_failed');
        const result = await github.replay(state.mergeCommit);
        if (result.status === 'pending') return progress('deployment_wait');
        if (result.status !== 'passed' || result.deployedCommit !== state.mergeCommit) throw Error('live_replay_failed');
        return progress('callback', { deployedCommit: result.deployedCommit, deploymentVerified: true, replayVerified: true });
      }
      case 'callback': {
        markMutation();
        const call = await caller.call(state);
        if (call.status !== 'submitted_not_verified') throw Error('callback_submission_unconfirmed');
        return progress('completed', { callbackStatus: call.status, completedAt: clock() });
      }
      default: throw Error('invalid_phase');
    }
  }

  return Object.freeze({
    async run(receiptId, { budgetMs = 220000 } = {}) {
      const deadline = clock() + Math.min(220000, Math.max(0, budgetMs));
      // A single external step has a bounded request budget; leave 60s to save
      // its outcome before the platform's 300s function deadline.
      while (clock() < deadline) {
        const job = await store.claim(receiptId);
        if (job.status !== 'claimed') return { status: job.status };
        let next, mutationStarted = false;
        try {
          if (clock() - Date.parse(job.createdAt) > 15 * 60 * 1000) throw Error('run_deadline');
          next = await step(job, () => { mutationStarted = true; });
        } catch (error) {
          const state = { ...job.state };
          if (error?.handle) state.handle = error.handle;
          if (state.handle) {
            try {
              const cleaned = await runner.cleanup(state.handle);
              state.cleanupVerified = ['deleted', 'not_found'].includes(cleaned.status) && cleaned.apiRemovalAcknowledged === true;
              if (state.cleanupVerified) state.handle = null;
            } catch { state.cleanupVerified = false; }
          }
          // Neither arbitrary exception text nor provider response bodies go
          // into storage/logs. A call/merge timeout may have succeeded remotely.
          next = { phase: writePhases.has(job.phase) && mutationStarted ? 'unknown' : 'failed',
            state: { ...state, stoppedAtPhase: job.phase,
              ...(job.phase === 'callback' ? { callbackStatus: 'unknown' } : {}) } };
        }
        // Do not retry this persistence write in a catch block: its response
        // could be lost after commit. The next claim resolves that ambiguity.
        await store.advance(job, next);
        logger({ event: 'incident_progress', receiptId, phase: next.phase });
        if (terminal.has(next.phase)) return { status: next.phase };
        if (next.phase === job.phase) await sleep(2000);
      }
      return { status: 'resume_required' };
    },
  });
}
