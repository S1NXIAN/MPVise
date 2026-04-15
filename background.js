/**
 * MPVise — background.js (Manifest V3 Service Worker)
 *
 * Responsibilities:
 *  - Sniff HLS master playlists via webRequest + Range-limited fetch
 *  - Per-tab stream cache with 5-minute TTL, O(1) Set-based dedup
 *  - Numeric badge (capped at "9+") with colour-coded states
 *  - Dynamic context menu title with stream count
 *  - Daemon health-check + 3-attempt exponential backoff
 *  - Rich Chrome notifications with Retry action
 *  - Dynamic popup.html for multi-stream picker
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT    = 8765;
const TTL_MS  = 5 * 60 * 1000; // 5-minute stream cache TTL

/**
 * Compiled master-playlist fingerprint.
 * A true master playlist MUST contain EXTM3U + EXT-X-STREAM-INF + BANDWIDTH.
 * A single regex is ~4× faster than chained includes() calls.
 */
const MASTER_RE = /^#EXTM3U[\s\S]{0,500}#EXT-X-STREAM-INF[\s\S]{0,80}BANDWIDTH=/m;

/** Segment-playlist guards — these markers never appear in master playlists. */
const SEGMENT_MARKERS = ['#EXT-X-TARGETDURATION', '#EXTINF:'];

/** Stable notification IDs — Chrome replaces existing entries with same ID. */
const N = {
  DETECTED:   'mpvise-det',
  EXTRACTING: 'mpvise-ext',
  SUCCESS:    'mpvise-ok',
  ERROR:      'mpvise-err',
};

const BADGE_COLOR = {
  ready:      '#34d399', // emerald — streams available
  extracting: '#f59e0b', // amber   — yt-dlp in progress
  error:      '#ef4444', // red     — something went wrong
};

// ─── Stream Cache ─────────────────────────────────────────────────────────────

/** @type {Map<number, {urls: Set<string>, ts: number}>} */
const cache = new Map();

/**
 * Get the stream Set for a tab, respecting TTL.
 * @param {number} tabId
 * @returns {Set<string>}
 */
function getStreams(tabId) {
  const entry = cache.get(tabId);
  if (!entry) return new Set();
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(tabId);
    return new Set();
  }
  return entry.urls;
}

/**
 * Add a stream URL to a tab's cache.
 * @param {number} tabId
 * @param {string} url
 * @returns {boolean} true if the URL was new (not a duplicate).
 */
function addStream(tabId, url) {
  let entry = cache.get(tabId);
  if (!entry || Date.now() - entry.ts > TTL_MS) {
    entry = { urls: new Set(), ts: Date.now() };
    cache.set(tabId, entry);
  }
  if (entry.urls.has(url)) return false;
  entry.urls.add(url);
  return true;
}

function clearTab(tabId) {
  cache.delete(tabId);
}

// ─── Badge & UI Helpers ───────────────────────────────────────────────────────

/** Format badge text: '' | '1'…'9' | '9+' */
function badgeText(count) {
  if (count === 0) return '';
  return count > 9 ? '9+' : String(count);
}

/**
 * Update the action badge for a tab.
 * @param {number} tabId
 * @param {'ready'|'extracting'|'error'} state
 */
async function updateBadge(tabId, state = 'ready') {
  const count = getStreams(tabId).size;
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: badgeText(count) }),
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: BADGE_COLOR[state] ?? BADGE_COLOR.ready,
    }),
  ]);
}

/**
 * Update the context menu title to reflect the active tab's stream count,
 * and toggle the "Play on yt-dlp" action-icon item visibility.
 * @param {number} tabId
 */
async function updateContextMenu(tabId) {
  const count = getStreams(tabId).size;
  try {
    await chrome.contextMenus.update('play', {
      title: count > 0 ? `Play with MPVise (${count})` : 'Play with MPVise',
    });
    await chrome.contextMenus.update('play-ytdlp', { visible: count > 0 });
  } catch (_) {
    // Menus may not exist yet (before onInstalled fires on first install).
  }
}

/**
 * Enable the stream-picker popup when there are multiple streams,
 * otherwise clear it so action.onClicked can fire directly.
 * @param {number} tabId
 */
async function updateActionPopup(tabId) {
  const count = getStreams(tabId).size;
  try {
    await chrome.action.setPopup({ tabId, popup: count > 1 ? 'popup.html' : '' });
  } catch (_) {}
}

/** Refresh all UI elements for a tab atomically. */
async function refreshUI(tabId, state = 'ready') {
  await Promise.all([
    updateBadge(tabId, state),
    updateContextMenu(tabId),
    updateActionPopup(tabId),
  ]);
}

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * Show a Chrome notification, reusing the slot if one with the same ID exists.
 * @param {string}                     id
 * @param {string}                     title
 * @param {string}                     message
 * @param {Array<{title: string}>}     [buttons]
 */
function notify(id, title, message, buttons = []) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/play-button-128.png',
    title,
    message: String(message).slice(0, 200),
    priority: 1,
    ...(buttons.length ? { buttons } : {}),
  });
}

// ─── Retry State ──────────────────────────────────────────────────────────────

/**
 * Stores the last failed request so the "Retry" notification button can replay it.
 * Module-scope is fine: if the SW is killed, the notification disappears too.
 * @type {{url:string, fallback:boolean, referer:string|null, tabId:number}|null}
 */
let _lastRetry = null;

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (notifId === N.ERROR && btnIdx === 0 && _lastRetry) {
    const { url, fallback, referer, tabId } = _lastRetry;
    await sendToServer(url, fallback, referer, tabId);
  }
});

// ─── Daemon Communication ─────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Returns true if the MPVise daemon is reachable within 2 seconds. */
async function pingDaemon() {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Send a play request to the daemon with 3-attempt exponential backoff.
 *
 * Backoff schedule: 200 ms → 400 ms → 800 ms between attempts.
 * 4xx errors are not retried (client fault).
 *
 * @param {string}      url      - Target media URL.
 * @param {boolean}     fallback - Use yt-dlp extraction.
 * @param {string|null} referer  - Referer header for mpv.
 * @param {number|null} tabId    - Source tab (for badge updates).
 */
async function sendToServer(url, fallback, referer, tabId = null) {
  // ── Health check ────────────────────────────────────────────────────────────
  const alive = await pingDaemon();
  if (!alive) {
    notify(N.ERROR, 'MPVise — Daemon Offline',
      'Run: python3 launcher.py start', [{ title: 'Dismiss' }]);
    if (tabId !== null) updateBadge(tabId, 'error');
    _lastRetry = { url, fallback, referer, tabId };
    return;
  }

  // ── Extraction progress indicator ───────────────────────────────────────────
  if (fallback) {
    notify(N.EXTRACTING, 'MPVise', 'Resolving stream via yt-dlp…');
    if (tabId !== null) updateBadge(tabId, 'extracting');
  }

  // ── Send with backoff ───────────────────────────────────────────────────────
  let lastErr = 'Unknown error';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 30_000);

      const resp = await fetch(`http://127.0.0.1:${PORT}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, fallback, referer }),
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (resp.ok) {
        const body = await resp.json().catch(() => ({}));
        chrome.notifications.clear(N.EXTRACTING);
        notify(N.SUCCESS, 'MPVise — Now Playing', body.message || 'Video sent to mpv');
        if (tabId !== null) updateBadge(tabId, 'ready');
        _lastRetry = null;
        return;
      }

      // Parse structured error from daemon
      const err = await resp.json().catch(() => ({}));
      lastErr = err.error || `HTTP ${resp.status}`;
      if (resp.status < 500) break; // don't retry 4xx errors

    } catch (e) {
      lastErr = e.name === 'AbortError' ? 'Request timed out' : (e.message || String(e));
    }

    if (attempt < 2) await sleep(200 * 2 ** attempt); // 200 → 400 → 800 ms
  }

  chrome.notifications.clear(N.EXTRACTING);
  notify(N.ERROR, 'MPVise — Playback Failed', lastErr, [{ title: 'Retry' }]);
  if (tabId !== null) updateBadge(tabId, 'error');
  _lastRetry = { url, fallback, referer, tabId };
}

// ─── Stream Detection ─────────────────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  ({ url, tabId }) => {
    // Fast path: skip non-m3u8 and background requests immediately.
    if (tabId <= 0 || !url.includes('.m3u8')) return;

    // Fetch only the first 4 KB to validate master playlist fingerprint.
    // Using Range header avoids downloading multi-MB manifests.
    fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-4095' },
      signal: AbortSignal.timeout(5000),
    })
      .then(r => r.text())
      .then(text => {
        // Must match master-playlist pattern
        if (!MASTER_RE.test(text)) return;
        // Must NOT be a media segment playlist
        if (SEGMENT_MARKERS.some(m => text.includes(m))) return;
        // Deduplicate via Set
        if (!addStream(tabId, url)) return;

        refreshUI(tabId);
        const count = getStreams(tabId).size;
        notify(
          N.DETECTED,
          'MPVise — Stream Detected',
          `Found ${count} HLS stream${count !== 1 ? 's' : ''} on this page`,
        );
      })
      .catch(() => {}); // Silently ignore network errors / CORS failures
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
);

// ─── Tab Lifecycle ────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => clearTab(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // Page navigation: clear stale streams immediately.
    clearTab(tabId);
    refreshUI(tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // Evict expired cache entries on tab switch.
  const entry = cache.get(tabId);
  if (entry && Date.now() - entry.ts > TTL_MS) clearTab(tabId);
  refreshUI(tabId);
});

// ─── Context Menus ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Remove all first to ensure clean state on extension update/reload.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'play',
      title: 'Play with MPVise',
      contexts: ['link', 'video', 'page'],
    });
    // Extension icon right-click item — hidden until a stream is detected.
    chrome.contextMenus.create({
      id: 'play-ytdlp',
      title: 'Play on yt-dlp',
      contexts: ['action'],
      visible: false,
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // "Play on yt-dlp" — always passes page URL directly to yt-dlp.
  if (info.menuItemId === 'play-ytdlp') {
    sendToServer(tab.url, true, tab.url, tab.id);
    return;
  }

  // "Play with MPVise" — priority order:
  //   1. Explicit element target (right-clicked video/link) — honour what the user clicked.
  //   2. Cached HLS stream — only when right-clicking the page background.
  //   3. Page URL via yt-dlp — last resort.
  const explicitUrl = info.srcUrl || info.linkUrl;

  if (explicitUrl && !explicitUrl.startsWith('blob:') && !explicitUrl.startsWith('data:')) {
    // User right-clicked a specific video or link — play that URL directly.
    sendToServer(explicitUrl, true, tab.url, tab.id);
    return;
  }

  // No specific element — prefer any cached HLS stream on this page.
  const streams = [...getStreams(tab.id)];
  if (streams.length) {
    sendToServer(streams[0], false, tab.url, tab.id);
    return;
  }

  // Nothing detected — try page URL via yt-dlp.
  sendToServer(tab.url, true, tab.url, tab.id);
});

// ─── Action Button (icon left-click) ─────────────────────────────────────────

chrome.action.onClicked.addListener(tab => {
  // This listener only fires when popup is NOT set (0 or 1 stream).
  // For 2+ streams, Chrome opens popup.html automatically.
  if (!tab.url || tab.url.startsWith('chrome://')) {
    notify(N.ERROR, 'MPVise — Invalid Page', 'Cannot play chrome:// pages.');
    return;
  }
  const streams = [...getStreams(tab.id)];
  if (streams.length === 1) {
    sendToServer(streams[0], false, tab.url, tab.id);
  } else {
    // No streams detected — attempt yt-dlp on the page URL.
    sendToServer(tab.url, true, tab.url, tab.id);
  }
});

// ─── Message Handler (popup.js ↔ service worker) ──────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STREAMS') {
    sendResponse({ streams: [...getStreams(msg.tabId)] });
    return false; // synchronous response
  }
  if (msg.type === 'PLAY_STREAM') {
    sendToServer(msg.url, false, msg.referer, msg.tabId);
    sendResponse({ ok: true });
    return false;
  }
});
