'use strict';

const PORT = 8765;

// ─── m3u8 Sniffer ─────────────────────────────────────────────────────────────
// Intercepts network requests to detect HLS master playlists.
// These are passed directly to mpv (no yt-dlp needed — instant playback).

/** tabId → Set<string> of confirmed master playlist URLs */
const hlsCache = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  ({ url, tabId }) => {
    if (tabId < 1 || !url.includes('.m3u8')) return;
    // Fetch only first 2 KB to confirm it's a master playlist
    fetch(url, {
      headers: { Range: 'bytes=0-2047' },
      signal:  AbortSignal.timeout(4000),
    })
      .then(r => r.text())
      .then(text => {
        // Master playlists contain stream variant entries; segment playlists don't.
        if (!text.includes('#EXT-X-STREAM-INF')) return;
        if (!hlsCache.has(tabId)) hlsCache.set(tabId, new Set());
        hlsCache.get(tabId).add(url);
      })
      .catch(() => {});
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
);

// Clear HLS cache on page navigation so stale streams don't persist.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') hlsCache.delete(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => hlsCache.delete(tabId));

// ─── Notify ───────────────────────────────────────────────────────────────────

function notify(title, msg) {
  chrome.notifications.create('mpvise', {
    type:     'basic',
    iconUrl:  'icons/play-button-128.png',
    title,
    message:  String(msg).slice(0, 200),
    priority: 1,
  });
}

// ─── URL Resolution ───────────────────────────────────────────────────────────

function resolveUrl(info, tab) {
  if (info.linkUrl) return info.linkUrl;
  const src = info.srcUrl;
  if (src && !src.startsWith('blob:') && !src.startsWith('data:')) return src;
  return tab.url;
}

// ─── Play ─────────────────────────────────────────────────────────────────────

async function play(url, referer, tabId = null) {
  if (!url || url.startsWith('chrome://') || url.startsWith('about:')) {
    notify('MPVise', 'Cannot play this page.'); return;
  }

  // Use a cached HLS stream only when no specific element URL was targeted
  // (i.e. icon click or page right-click). A right-clicked link/video should
  // play exactly what was clicked, not a different stream from the cache.
  const usingPageUrl = url === referer;
  const streams = usingPageUrl && tabId !== null ? hlsCache.get(tabId) : null;
  const target  = streams?.size ? [...streams][0] : url;
  const direct  = target !== url; // true = pre-validated m3u8, skip yt-dlp

  // Health-check daemon (2 s timeout).
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) throw new Error();
  } catch {
    notify('MPVise — Offline', 'Run:  python3 launcher.py start'); return;
  }

  notify('MPVise', direct ? 'Playing HLS stream…' : 'Resolving via yt-dlp…');

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/play`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: target, referer, direct }),
      signal:  AbortSignal.timeout(35_000),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok) {
      notify('MPVise — Playing ▶', target.slice(0, 120));
    } else {
      notify('MPVise — Failed', body.error || `HTTP ${resp.status}`);
    }
  } catch (e) {
    notify('MPVise — Error',
      e.name === 'AbortError' ? 'Timed out (35 s)' : (e.message || String(e)));
  }
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'play',
    title:    'Play with MPVise',
    contexts: ['page', 'link', 'video', 'audio'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  play(resolveUrl(info, tab), tab.url, tab.id);
});

// ─── Icon Click ───────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(tab => {
  play(tab.url, tab.url, tab.id);
});
