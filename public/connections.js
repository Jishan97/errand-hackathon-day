const connect = document.querySelector('#connect');
const retry = document.querySelector('#retry');
const state = document.querySelector('#gmail-state');
const message = document.querySelector('#status-message');
const account = document.querySelector('#account');
const callbackFailed = new URLSearchParams(location.search).get('connection') === 'failed';
if (location.search) history.replaceState(null, '', location.pathname);

function show(label, detail, canConnect = false) {
  state.textContent = label;
  state.classList.toggle('connected', label === 'Connected');
  message.textContent = detail;
  connect.disabled = !canConnect;
  retry.hidden = false;
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error('setup_required'); }
  if (!response.ok) throw new Error(data.error || 'service_unavailable');
  return data;
}
function failed(error) {
  account.hidden = true;
  if (error.message === 'sign_in_required') {
    show('Sign-in needed', 'Open the operator sign-in link above, sign in, then return here and check again.');
  } else if (error.message === 'setup_required') {
    show('Setup pending', 'Gmail setup is not available on this preview yet. Ask the demo operator to complete activation.');
  } else if (['connection_unavailable', 'not_connected'].includes(error.message)) {
    show('Reconnect needed', 'Your Gmail connection needs attention. Connect again to review access with Google.', true);
  } else {
    show('Could not check', 'We could not confirm your connection. Please check again in a moment.');
  }
}
async function refresh() {
  connect.disabled = true; retry.hidden = true;
  try {
    const data = await api('/api/connections/gmail');
    account.hidden = true;
    if (data.status === 'connected' && typeof data.email === 'string') {
      account.textContent = data.email; account.hidden = false;
      show('Connected', callbackFailed ? 'The new connection did not finish. Your previous Gmail connection is still active.' : 'Gmail is connected. Your phone service must also be ready before you can use it by call.');
    } else if (data.status === 'not_connected') {
      show('Not connected', callbackFailed ? 'The connection did not finish. Please try connecting Gmail again.' : 'Connect your own Gmail to get started. You will review access with Google.', true);
    } else throw new Error('service_unavailable');
  } catch (error) { failed(error); }
}
connect.addEventListener('click', async () => {
  show('Opening Google sign-in', 'Taking you to the secure connection page…');
  try {
    const data = await api('/api/connections/gmail/connect', { method: 'POST', headers: { 'X-Errand-Intent': 'connect-gmail' } });
    const redirect = new URL(data.redirectUrl);
    if (redirect.origin !== 'https://connect.composio.dev' || redirect.username || redirect.password) throw new Error('service_unavailable');
    location.assign(redirect.href);
  } catch (error) { failed(error); }
});
retry.addEventListener('click', refresh);
await refresh();
