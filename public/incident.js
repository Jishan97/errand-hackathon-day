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
    invalid_request: 'The revision request was rejected by the route. Refresh this page to load the latest version.',
    operator_required: 'The request did not include valid operator authorization. Enter the token privately and try again.',
    incident_unconfigured: 'An existing runtime setting or enable switch is missing or invalid. Follow the setup guide privately.',
    incident_github_disabled: 'Set ENABLE_GITHUB_APP=true in errand-hackathon-day Production, then redeploy.',
    incident_github_unconfigured: 'The existing GitHub App settings are incomplete or invalid in the main deployment. Review the App settings and PUBLIC_BASE_URL privately.',
    incident_callback_disabled: 'Set ENABLE_LIVE_VOICE=true in errand-hackathon-day Production, then redeploy.',
    incident_callback_unconfigured: 'The existing Twilio callback settings are incomplete or invalid in the main deployment. Review the account, token and configured test numbers privately.',
    incident_model_unconfigured: 'Set OPENAI_AGENT_MODEL=gpt-6.1-sol in errand-hackathon-day Production, then redeploy.',
    incident_openai_unconfigured: 'The main deployment is missing OPENAI_API_KEY. Add the existing key privately and redeploy.',
    fast_storage_unconfigured: 'Check the existing Supabase URL and secret key privately in the main deployment.',
    fast_storage_request_unconfirmed: 'Storage did not confirm this operation. Check the latest run and setup guide before retrying.',
    github_app_permissions_required: 'The selected GitHub App installation needs Checks and Actions read, plus Contents and Pull requests write.',
    github_app_not_connected: 'The existing GitHub App connection could not be found in the configured database.',
    github_connection_unverified: 'The saved GitHub App connection does not match this demo repository. Its existing connection needs review.',
    incident_base_changed: 'The demo revision changed. Read and review its current revision again.',
    incident_ci_definition_changed: 'The demo regression workflow differs from the trusted version. Review it before arming.' };
  if (!response.ok) throw Error(setupErrors[result.error] ?? (result.error === 'incident_operation_unavailable'
    ? 'The incident operation is unavailable. Check the setup guide and current demo revision; no success is assumed.'
    : result.error === 'operator_rejected' ? 'Operator token rejected.' : 'Request could not be completed.'));
  return result;
}
async function act(fn) {
  el('notice').textContent = '';
  try { await fn(); }
  catch (e) {
    el('notice').textContent = e.message;
    el('notice').focus();
    el('notice').scrollIntoView({ block: 'center' });
  }
}
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
  const button = el('prepare');
  button.disabled = true;
  button.textContent = 'Checking demo revision…';
  prepared = null;
  el('arm').disabled = true;
  el('revision').textContent = 'Checking access and reading the current GitHub revision…';
  try {
    prepared = await api('prepare', {});
    el('revision').textContent = `${prepared.repository} · ${prepared.baseSha}`;
    el('arm').disabled = false;
  } catch (error) {
    el('revision').textContent = 'Revision check failed. Approval remains disabled; see the message above.';
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = 'Read current demo revision';
  }
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
