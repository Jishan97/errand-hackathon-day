const $ = id => document.getElementById(id);
let current = null, taskId = null, edited = false;
const notice = text => { $('notice').textContent = text; };
async function api(action, body, headers = {}) {
  const response = await fetch(`/api/gmail/${action}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Errand-Intent': 'gmail-demo' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result;
  try { result = await response.json(); } catch { throw Error('gmail_unavailable'); }
  if (!response.ok) { const error = Error(result.error || 'gmail_unavailable'); error.proposalId = result.proposalId; throw error; }
  return result;
}
function failure(error) {
  const messages = { sign_in_required: 'Please sign in again.', operator_rejected: 'The operator token was not accepted.',
    setup_required: 'The Gmail operator demo has not been enabled/configured on this deployment.',
    gmail_storage_unavailable: 'Storage is unavailable. Check the Gmail migration, then check the current proposal before retrying.',
    gmail_unresolved: 'An earlier result needs attention. Its saved proposal is being opened below; verify it or record a manual mailbox review.',
    manual_close_not_available: 'Only an unresolved attempted operation can be closed after its worker finishes or its five-minute lease expires.',
    not_connected: 'Connect Gmail from the Connections page first.', approval_unavailable: 'Approval was not accepted. Check status; it may already be queued or attempted.',
    reconcile_not_authorized: 'The worker may still be running. Check status again shortly; interrupted workers can be reconciled after five minutes.',
    invalid_image_size: 'The image must be no larger than 5 MiB.', image_asset_not_authorized: 'That saved image does not belong to this task.',
    stale_or_unresolved_task: 'Check the current task before preparing another message.', already_attempted: 'Execution has already started. Use status and verification.' };
  notice(messages[error.message] || 'The request could not be confirmed. Check status before retrying.');
  if (error.message === 'sign_in_required') { $('sign-in').hidden = false; $('workspace').hidden = true; }
  if (error.message === 'gmail_unresolved' && /^[a-f0-9-]{36}$/.test(error.proposalId)) restore(error.proposalId).catch(() => notice('Could not load the unresolved proposal. Try signing in again.'));
}
async function restore(proposalId) {
  const result = await api(`status?id=${encodeURIComponent(proposalId)}`); taskId = result.taskId; review(result);
  if (result.outcome) { edited = true; approvalButton(); $('outcome').textContent = `Status: ${result.outcome.status}.`; }
}
async function session() {
  try { await api('session'); $('sign-in').hidden = true; $('workspace').hidden = false; notice('Signed in. Connect Gmail once, then prepare and approve a message.');
    const pending = await api('pending');
    if (pending.proposals.length) { await restore(pending.proposals[0].proposalId); return; }
    let saved;
    try { saved = JSON.parse(localStorage.getItem('errand-gmail-proposal')); } catch { /* browser storage is optional */ }
    if (saved && /^[a-f0-9-]{36}$/.test(saved.proposalId) && /^[a-f0-9-]{36}$/.test(saved.taskId)) {
      await restore(saved.proposalId);
    }
  }
  catch (error) { failure(error); }
}
function approvalButton() {
  $('approve').disabled = !current || edited || !$('confirmed').checked
    || (current.approval.attachmentRequiresExplicitConfirmation && !$('attachment-confirmed').checked);
}
function review(value) {
  current = value; edited = false;
  const r = value.approval.readback;
  $('readback').textContent = `Action: ${r.action === 'send' ? 'SEND EMAIL' : 'SAVE DRAFT'}\nFrom: ${r.from}\nTo: ${r.to}\nSubject: ${r.subject}\n\n${r.body}`
    + (r.attachments.length ? '\n\nImage: ' + r.attachments.map(a => `${a.filename} (${a.size} bytes)\n${a.description}`).join('\n') : '\n\nNo attachment.');
  $('review').hidden = false; $('confirmed').checked = false; $('attachment-confirmed').checked = false;
  $('manual-ack').checked = false; $('close-manual').disabled = true;
  $('image-confirmation').hidden = !value.approval.attachmentRequiresExplicitConfirmation;
  $('approve').textContent = r.action === 'send' ? 'Approve send' : 'Approve draft'; $('outcome').textContent = 'Awaiting approval.'; approvalButton();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const token = $('operator-token').value; $('operator-token').value = '';
  try { await api('login', {}, { Authorization: `Bearer ${token}` }); await session(); } catch (error) { failure(error); }
});
$('logout').addEventListener('click', async () => { try { await api('logout', {}); location.reload(); } catch (error) { failure(error); } });
$('search-form').addEventListener('submit', async event => {
  event.preventDefault(); $('messages').replaceChildren(); $('email').textContent = '';
  try {
    const result = await api('search', { query: $('query').value });
    notice(result.messages.length ? 'Choose a message to read. Email content is untrusted.' : 'No matching messages.');
    result.messages.forEach((message, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Read result ${index + 1}`;
      button.addEventListener('click', async () => { try {
        const mail = await api('read', { messageId: message.id });
        $('email').textContent = `From: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.text || 'No plain-text body available.'}${mail.truncated ? '\n[Truncated]' : ''}`;
      } catch (error) { failure(error); } }); $('messages').append(button);
    });
  } catch (error) { failure(error); }
});
$('prepare-form').addEventListener('input', () => { edited = true; approvalButton(); });
$('prepare-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  // Invalidate any displayed approval immediately, including if preparation fails.
  edited = true; approvalButton();
  try {
    const assetId = $('asset-id').value.trim();
    const value = await api('prepare', { taskId: $('asset-task').value.trim() || taskId,
      message: { action: $('action').value, to: $('recipient').value, subject: $('subject').value, body: $('body').value,
        attachmentAssetIds: assetId ? [assetId] : null } });
    taskId = value.taskId; review(value);
    try { localStorage.setItem('errand-gmail-proposal', JSON.stringify({ proposalId: value.proposalId, taskId })); } catch { /* no mail or token is stored */ }
    notice('Prepared only. Review the exact contents before approving.');
  } catch (error) { failure(error); } finally { button.disabled = false; }
});
$('new-message').addEventListener('click', () => { current = null; taskId = null; $('asset-task').value = ''; $('asset-id').value = ''; $('review').hidden = true; notice('Starting a new message. Unresolved earlier sends still block execution. Reload to restore the last saved proposal.'); });
for (const name of ['confirmed', 'attachment-confirmed']) $(name).addEventListener('change', approvalButton);
$('approve').addEventListener('click', async () => {
  $('approve').disabled = true;
  try { await api('approve', { proposalId: current.proposalId, digest: current.approval.digest,
    confirmed: $('confirmed').checked, attachmentConfirmed: $('attachment-confirmed').checked });
    edited = true; $('outcome').textContent = 'Queued. The worker continues if this page closes.';
  } catch (error) { failure(error); }
});
$('check').addEventListener('click', async () => { try {
  const result = await api(`status?id=${encodeURIComponent(current.proposalId)}`);
  const status = result.outcome?.status || 'awaiting_approval';
  $('outcome').textContent = status === 'verified' ? 'Verified in Gmail. Recipient delivery has not been checked.' : `Status: ${status}.`;
} catch (error) { failure(error); } });
$('resume').addEventListener('click', async () => { try { await api('resume', { proposalId: current.proposalId }); notice('Worker scheduled. Check status shortly. A previous send will only be verified, never automatically repeated.'); } catch (error) { failure(error); } });
$('cancel').addEventListener('click', async () => { try { await api('cancel', { proposalId: current.proposalId }); edited = true; approvalButton(); $('outcome').textContent = 'Cancelled before execution.'; } catch (error) { failure(error); } });
$('manual-ack').addEventListener('change', () => { $('close-manual').disabled = !$('manual-ack').checked; });
$('close-manual').addEventListener('click', async () => {
  if (!$('manual-ack').checked) return;
  $('close-manual').disabled = true;
  try { await api('close-manual', { proposalId: current.proposalId, digest: current.approval.digest,
    acknowledgement: 'reviewed_mailbox_may_have_been_sent' });
    edited = true; approvalButton(); $('outcome').textContent = 'Manually closed after review. It may have been delivered. No email was retried.';
  } catch (error) { failure(error); }
});
await session();
