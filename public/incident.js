const el = (id) => document.getElementById(id);
let prepared = null, receiptId = null, timer = null;
const labels = { repair_start: 'Starting the approved coding run', repair_poll: 'Reproducing and fixing the bug',
  cleanup: 'Verifying coding evidence', create_pr: 'Opening the repair PR', ci_wait: 'Waiting for GitHub checks',
  merge: 'Merging the checked revision', deployment_wait: 'Waiting for the live commit and upload replay',
  callback: 'Submitting your completion call', completed: 'Live repair verified · callback submitted',
  failed: 'Stopped: repair completion is not verified', unknown: 'Stopped: an external action is unconfirmed; do not retry it' };
async function api(action, body) {
  const token = el('operator').value;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Error('Enter the existing operator token privately.');
  const response = await fetch(`/api/incident/${action}`, { method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  const setupErrors = { incident_disabled: 'Enable ENABLE_FAST_INCIDENT_DEMO=true in main Vercel Production, then redeploy.',
    incident_unconfigured: 'An existing runtime setting or enable switch is missing or invalid. Follow the setup guide privately.',
    fast_storage_unconfigured: 'Check the existing Supabase URL and secret key privately in the main deployment.',
    fast_storage_request_unconfirmed: 'Storage did not confirm this operation. Check the latest run and setup guide before retrying.',
    github_app_permissions_required: 'The selected GitHub App installation needs Checks and Actions read, plus Contents and Pull requests write.',
    github_app_not_connected: 'The existing GitHub App connection could not be found in the configured database.',
    incident_base_changed: 'The demo revision changed. Read and review its current revision again.',
    incident_ci_definition_changed: 'The demo regression workflow differs from the trusted version. Review it before arming.' };
  if (!response.ok) throw Error(setupErrors[result.error] ?? (result.error === 'incident_operation_unavailable'
    ? 'The incident operation is unavailable. Check the setup guide and current demo revision; no success is assumed.'
    : result.error === 'operator_rejected' ? 'Operator token rejected.' : 'Request could not be completed.'));
  return result;
}
async function act(fn) { el('notice').textContent = ''; try { await fn(); } catch (e) { el('notice').textContent = e.message; } }
async function refresh() {
  const data = await api('status');
  if (data.status !== 'found') { el('status').textContent = 'Waiting for an approved Sentry alert.'; return; }
  receiptId = data.receiptId;
  el('status').textContent = labels[data.phase] ?? data.phase;
  el('details').textContent = JSON.stringify(data, null, 2);
  el('resume').disabled = ['completed', 'failed', 'unknown'].includes(data.phase);
  if (el('resume').disabled && timer) { clearInterval(timer); timer = null; }
}
el('prepare').onclick = () => act(async () => {
  prepared = await api('prepare', {});
  el('revision').textContent = `${prepared.repository} · ${prepared.baseSha}`;
  el('arm').disabled = false;
});
el('arm').onclick = () => act(async () => {
  el('arm').disabled = true;
  const result = await api('arm', { baseSha: prepared.baseSha, scope: prepared.scope });
  el('approval').textContent = `One run approved. Expires: ${new Date(result.expiresAt).toLocaleTimeString()}. Trigger the sample now.`;
  if (timer) clearInterval(timer);
  timer = setInterval(() => act(refresh), 4000);
});
el('refresh').onclick = () => act(refresh);
el('resume').onclick = () => act(async () => { if (receiptId) await api('resume', { receiptId }); await refresh(); });
window.addEventListener('pagehide', () => { el('operator').value = ''; if (timer) clearInterval(timer); });
