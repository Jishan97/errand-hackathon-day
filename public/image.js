const el = id => document.getElementById(id);
let imageUrl = null;
let watching = false, watchTimer = null, watchedImage = null;
const messages = {
  operator_required: 'Open Demo access and enter the token your host provided.',
  operator_rejected: 'That access token was not accepted. Please check it with your host.',
  image_setup_required: 'Image generation is not configured on this preview yet. Your host needs to connect the server settings.',
  image_access_required: 'The image service needs access to the configured model. Ask your host to check its setup.',
  image_model_invalid: 'The server image model setting needs attention. Ask your host to check it.',
  image_request_blocked: 'We could not make that picture. Try describing a different idea.',
  image_rate_limited: 'The image service is busy or has reached its limit. Please try later.',
  image_generation_timed_out: 'This picture took too long to return. It may still have been generated. We have not retried it.',
  image_response_too_large: 'The picture was too large to display here. Try a simpler idea.',
  invalid_prompt: 'Describe your picture in 1–2,000 characters.',
};
const controls = [...document.querySelectorAll('#image-form button, #image-form textarea, #image-form input')];
async function showImage(blob, prompt) {
  if (!blob.size || blob.size > 3 * 1024 * 1024) throw Error('The picture could not be displayed. Please check with your host.');
  const nextUrl = URL.createObjectURL(blob);
  try { el('picture').src = nextUrl; await el('picture').decode(); }
  catch { URL.revokeObjectURL(nextUrl); throw Error('The returned picture could not be opened. Please check with your host.'); }
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = nextUrl; el('picture').alt = `AI-generated picture: ${prompt}`;
  el('picture').hidden = false; el('empty').hidden = true; el('loading').hidden = true;
  el('caption').textContent = prompt; el('download').href = imageUrl; el('download').hidden = false;
  el('result-label').textContent = 'Made for you'; el('result-panel').setAttribute('aria-busy', 'false');
}
function stopWatching() {
  watching = false; clearTimeout(watchTimer); el('watch').textContent = 'Watch phone requests';
}
async function pollPhone() {
  if (!watching) return;
  try {
    const headers = { Authorization: `Bearer ${el('operator').value.trim()}` };
    const response = await fetch('/api/images/latest', { headers, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw Error(messages[data.error] || 'The phone screen is not connected yet. Ask your host to check the image storage setup.');
    if (!watching) return;
    const image = data.image;
    if (!image) el('notice').textContent = 'Screen connected. Call Errand and ask for a picture.';
    else if (image.status === 'running') {
      el('result-label').textContent = 'Creating from your call…'; el('result-panel').setAttribute('aria-busy', 'true');
      el('picture').hidden = true; el('empty').hidden = true; el('download').hidden = true; el('loading').hidden = false;
      el('notice').textContent = `Making your phone request: ${image.prompt}`;
    } else if (image.status === 'ready' && image.id !== watchedImage) {
      const result = await fetch(`/api/images/result?id=${encodeURIComponent(image.id)}`, { headers, cache: 'no-store' });
      if (!result.ok || result.headers.get('content-type') !== 'image/jpeg') throw Error('The phone picture is not available yet. Please reconnect this screen.');
      const blob = await result.blob(); if (!watching) return;
      await showImage(blob, image.prompt); watchedImage = image.id;
      el('notice').textContent = 'Your phone picture is ready. Download it below, or ask for another on the call.';
    } else if (['failed', 'uncertain'].includes(image.status)) {
      el('loading').hidden = true; el('empty').hidden = false; el('result-panel').setAttribute('aria-busy', 'false');
      el('result-label').textContent = 'Picture not confirmed';
      el('notice').textContent = 'This phone picture could not be confirmed. Ask your host to check before requesting it again.';
    }
  } catch (error) { if (watching) { el('notice').textContent = error.message; stopWatching(); } }
  if (watching) watchTimer = setTimeout(pollPhone, 2500);
}
el('watch').addEventListener('click', () => {
  if (watching) { stopWatching(); return; }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(el('operator').value.trim())) {
    el('access').open = true; el('notice').textContent = messages.operator_required; el('operator').focus(); return;
  }
  watching = true; el('watch').textContent = 'Disconnect screen'; void pollPhone();
});
for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => { el('prompt').value = button.dataset.example; el('prompt').focus(); });
}
el('image-form').addEventListener('submit', async event => {
  event.preventDefault();
  const token = el('operator').value.trim(), prompt = el('prompt').value.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    el('access').open = true; el('notice').textContent = messages.operator_required; el('operator').focus(); return;
  }
  if (!prompt || prompt.length > 2000) { el('notice').textContent = messages.invalid_prompt; return; }
  stopWatching();
  controls.forEach(control => control.disabled = true);
  el('notice').textContent = 'Generating your picture. Please keep this tab open.';
  el('result-panel').setAttribute('aria-busy', 'true');
  el('result-label').textContent = 'Creating…'; el('empty').hidden = true; el('picture').hidden = true;
  el('download').hidden = true; el('loading').hidden = false;
  try {
    const response = await fetch('/api/images/generate', { method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
    if (!response.ok) {
      let data; try { data = await response.json(); } catch { data = {}; }
      throw Error(messages[data.error] || 'The picture could not be confirmed. Please check with your host before trying again.');
    }
    if (response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') throw Error('The server did not return a picture. Please check with your host.');
    const blob = await response.blob();
    await showImage(blob, prompt); el('notice').textContent = 'Your picture is ready. You can download it below.';
  } catch (error) {
    el('picture').hidden = true; el('empty').hidden = false; el('result-label').textContent = 'Picture not completed';
    el('notice').textContent = error.message || 'The connection was interrupted. We have not retried your request.';
  } finally {
    el('loading').hidden = true; el('result-panel').setAttribute('aria-busy', 'false');
    controls.forEach(control => control.disabled = false);
  }
});
window.addEventListener('pagehide', () => { stopWatching(); if (imageUrl) URL.revokeObjectURL(imageUrl); });
