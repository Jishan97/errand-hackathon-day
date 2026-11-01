// Credential-free PostgreSQL execution tests. Install @electric-sql/pglite@0.5.14
// in a temporary folder and pass the absolute dist/index.js file as argv[2].
// No dotenv, project connection, service key or production data is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Pass an explicit PGlite module path');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const sql = await readFile(new URL('./fast-incident.sql', import.meta.url), 'utf8');
const receipt = 'a'.repeat(32), sha = 'b'.repeat(40), scope = 'upload-parser-fix-test-pr-merge-replay-callback';
const sample = { eventId: receipt, project: '123', title: 'Sample plant upload failed', details: { baseSha: sha, issueId: '456', fixture: 'upload_lf_v1' } };

async function fixture(run) {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(sql);
    const rpc = async (name, args = []) => {
      const result = await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as result`, args);
      return result.rows[0].result;
    };
    await run(db, rpc);
  } finally { await db.close(); }
}

test('actual SQL approval is scoped, expiring, one-use and duplicate delivery is atomic', async () => fixture(async (db, rpc) => {
  assert.equal((await rpc('errand_fast_accept', [sample])).status, 'unarmed');
  await assert.rejects(rpc('errand_fast_arm', [sha, 'broader-scope']));
  const approval = await rpc('errand_fast_arm', [sha, scope]);
  assert.equal(approval.status, 'approved');
  assert.equal((await rpc('errand_fast_arm', [sha, scope])).id, approval.id);
  const wrong = { ...sample, eventId: 'c'.repeat(32), details: { ...sample.details, baseSha: 'd'.repeat(40) } };
  assert.equal((await rpc('errand_fast_accept', [wrong])).status, 'unarmed');
  const results = await Promise.all([rpc('errand_fast_accept', [sample]), rpc('errand_fast_accept', [sample])]);
  assert.deepEqual(results.map((r) => r.status), ['queued', 'duplicate']);
  assert.equal((await db.query('select count(*)::integer as n from errand.fast_runs')).rows[0].n, 1);
  await assert.rejects(rpc('errand_fast_arm', [sha, scope]), /fast_run_active/);
  assert.equal((await rpc('errand_fast_accept', [{ ...sample, eventId: 'e'.repeat(32) }])).status, 'unarmed');
}));

test('actual SQL lease prevents duplicate effects and expired mutation is quarantined', async () => fixture(async (db, rpc) => {
  await rpc('errand_fast_arm', [sha, scope]); await rpc('errand_fast_accept', [sample]);
  const job = await rpc('errand_fast_claim', [receipt]);
  assert.equal(job.status, 'claimed'); assert.equal(job.phase, 'repair_start');
  assert.equal((await rpc('errand_fast_claim', [receipt])).status, 'busy');
  await assert.rejects(rpc('errand_fast_advance', [receipt, '11111111-1111-4111-8111-111111111111', 'repair_poll', {}]), /fast_lease_invalid/);
  await db.query("update errand.fast_runs set claimed_at=clock_timestamp()-interval '3 minutes' where id=$1", [receipt]);
  assert.deepEqual(await rpc('errand_fast_claim', [receipt]), { status: 'terminal', phase: 'unknown' });
  assert.equal((await rpc('errand_fast_status', [receipt])).stoppedAtPhase, 'repair_start');
  await assert.rejects(rpc('errand_fast_arm', [sha, scope]), /fast_run_needs_reconciliation/);
}));

test('actual SQL refuses misleading rearm of a failed revision without restarting it', async () => fixture(async (db, rpc) => {
  await rpc('errand_fast_arm', [sha, scope]); await rpc('errand_fast_accept', [sample]);
  const job = await rpc('errand_fast_claim', [receipt]);
  await rpc('errand_fast_advance', [receipt, job.lease, 'failed', { stoppedAtPhase: 'repair_start' }]);
  await assert.rejects(rpc('errand_fast_arm', [sha, scope]), /fast_failed_revision_requires_review/);
  assert.deepEqual(await rpc('errand_fast_claim', [receipt]), { status: 'terminal', phase: 'failed' });
  assert.equal((await rpc('errand_fast_accept', [sample])).status, 'duplicate');
  assert.equal((await db.query('select count(*)::integer as n from errand.fast_approvals')).rows[0].n, 1);
  assert.equal((await rpc('errand_fast_arm', ['c'.repeat(40), scope])).status, 'approved');
}));

test('actual SQL safe poll can resume after lease expiry', async () => fixture(async (db, rpc) => {
  await rpc('errand_fast_arm', [sha, scope]); await rpc('errand_fast_accept', [sample]);
  const first = await rpc('errand_fast_claim', [receipt]);
  await rpc('errand_fast_advance', [receipt, first.lease, 'repair_poll', { handle: { sessionId: 'fictional' } }]);
  const poll = await rpc('errand_fast_claim', [receipt]);
  await db.query("update errand.fast_runs set claimed_at=clock_timestamp()-interval '3 minutes' where id=$1", [receipt]);
  const resumed = await rpc('errand_fast_claim', [receipt]);
  assert.equal(resumed.status, 'claimed'); assert.notEqual(resumed.lease, poll.lease);
  assert.equal(resumed.state.handle.sessionId, 'fictional');
}));

test('actual SQL requires test/CI/exact-replay evidence before completion callback', async () => fixture(async (db, rpc) => {
  await rpc('errand_fast_arm', [sha, scope]); await rpc('errand_fast_accept', [sample]);
  let job = await rpc('errand_fast_claim', [receipt]);
  await assert.rejects(rpc('errand_fast_advance', [receipt, job.lease, 'callback', {}]), /fast_phase_invalid/);
  const move = async (next, state) => {
    await rpc('errand_fast_advance', [receipt, job.lease, next, state]);
    job = await rpc('errand_fast_claim', [receipt]);
  };
  await move('repair_poll', {}); await move('cleanup', {});
  await assert.rejects(rpc('errand_fast_advance', [receipt, job.lease, 'create_pr', {}]), /fast_tests_required/);
  const state = { testsPassed: true, handle: { sessionId: 'not-public' } };
  await move('create_pr', state); await move('ci_wait', state);
  await assert.rejects(rpc('errand_fast_advance', [receipt, job.lease, 'merge', state]), /fast_ci_required/);
  state.ciPassed = true; await move('merge', state);
  state.mergeCommit = 'c'.repeat(40); await move('deployment_wait', state);
  state.deployedCommit = 'd'.repeat(40); state.replayVerified = true;
  await assert.rejects(rpc('errand_fast_advance', [receipt, job.lease, 'callback', state]), /fast_replay_required/);
  state.deployedCommit = state.mergeCommit;
  await assert.rejects(rpc('errand_fast_advance', [receipt, job.lease, 'callback', state]), /fast_replay_required/);
  state.deploymentVerified = true; await move('callback', state);
  await assert.rejects(rpc('errand_fast_advance', [receipt, job.lease, 'completed', state]), /fast_callback_required/);
  state.callbackStatus = 'submitted_not_verified'; await move('completed', state);
  assert.deepEqual(job, { status: 'terminal', phase: 'completed' });
  const result = await rpc('errand_fast_status', [receipt]);
  assert.equal(result.phase, 'completed'); assert.equal(result.replayVerified, true);
  assert.equal(result.callbackStatus, 'submitted_not_verified');
  assert.equal(JSON.stringify(result).includes('not-public'), false);
  assert.equal((await rpc('errand_fast_status')).receiptId, receipt);
}));

test('actual SQL revokes anonymous/authenticated access; only service role can execute', async () => fixture(async (db, rpc) => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(rpc('errand_fast_arm', [sha, scope]), /permission denied/);
    await assert.rejects(db.query('select * from errand.fast_runs'), /permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  assert.equal((await rpc('errand_fast_arm', [sha, scope])).status, 'approved');
  assert.equal((await rpc('errand_fast_accept', [sample])).status, 'queued');
  await db.exec('reset role');
  const functions = await db.query("select prosecdef from pg_proc where proname like 'errand_fast_%'");
  assert.equal(functions.rows.length, 5);
  assert.equal(functions.rows.every((r) => r.prosecdef === false), true);
}));

test('actual SQL rejects expired approvals, raw event fields and secret-shaped state', async () => fixture(async (db, rpc) => {
  await rpc('errand_fast_arm', [sha, scope]);
  await db.exec("update errand.fast_approvals set expires_at=clock_timestamp()-interval '1 minute'");
  assert.equal((await rpc('errand_fast_accept', [sample])).status, 'unarmed');
  await assert.rejects(rpc('errand_fast_accept', [{ ...sample, raw: 'private' }]), /invalid_fast_event/);
  await rpc('errand_fast_arm', [sha, scope]); await rpc('errand_fast_accept', [sample]);
  const job = await rpc('errand_fast_claim', [receipt]);
  await assert.rejects(rpc('errand_fast_advance', [receipt, job.lease, 'repair_poll', { auth_token: 'synthetic' }]), /invalid_fast_state/);
}));
