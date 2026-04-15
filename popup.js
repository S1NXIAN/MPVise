/**
 * MPVise — popup.js
 *
 * Rendered inside popup.html when the user clicks the extension icon
 * and more than one HLS stream has been detected on the current page.
 *
 * Communicates with the service worker via chrome.runtime.sendMessage:
 *  → GET_STREAMS  { tabId }             — returns { streams: string[] }
 *  → PLAY_STREAM  { url, referer, tabId } — triggers playback
 */

(async () => {
  const list  = document.getElementById('list');
  const badge = document.getElementById('badge');

  // ── Get the active tab ─────────────────────────────────────────────────────
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    list.innerHTML = '<div class="empty">No active tab found.</div>';
    badge.textContent = '0';
    return;
  }

  // ── Request detected streams from the service worker ───────────────────────
  let streams = [];
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STREAMS', tabId: tab.id });
    streams = resp?.streams ?? [];
  } catch (e) {
    list.innerHTML = '<div class="empty">Could not reach extension background.</div>';
    badge.textContent = '?';
    return;
  }

  badge.textContent = String(streams.length);

  if (streams.length === 0) {
    list.innerHTML = '<div class="empty">No HLS streams detected on this page.</div>';
    return;
  }

  // ── Build stream buttons ───────────────────────────────────────────────────
  list.innerHTML = '';

  streams.forEach((url, i) => {
    const btn = document.createElement('button');
    btn.className   = 'stream-btn';
    btn.title       = url;
    btn.innerHTML   = `
      <div class="stream-icon">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 2.5l10 5.5-10 5.5z"/>
        </svg>
      </div>
      <div class="stream-info">
        <div class="stream-label">Stream ${i + 1}</div>
        <div class="stream-url">${url}</div>
      </div>
    `;

    btn.addEventListener('click', async () => {
      // Disable all buttons to prevent double-play
      list.querySelectorAll('.stream-btn').forEach(b => { b.disabled = true; });

      try {
        await chrome.runtime.sendMessage({
          type:    'PLAY_STREAM',
          url,
          referer: tab.url,
          tabId:   tab.id,
        });
      } catch (_) {}

      window.close();
    });

    list.appendChild(btn);
  });
})();
