'use strict';

const PORT = 8765;
const hlsCache = new Map();

// ─── m3u8 Sniffer ────────────────────────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  ({url, tabId}) => {
    if (!tabId || !url.includes('.m3u8')) return;
    fetch(url, {headers: {Range: 'bytes=0-2048'}, signal: AbortSignal.timeout(4000)})
      .then(r => r.text())
      .then(text => {
        if (text.includes('#EXT-X-STREAM-INF')) {
          if (!hlsCache.has(tabId)) hlsCache.set(tabId, new Set());
          hlsCache.get(tabId).add(url);
        }
      })
      .catch(() => {});
  },
  {urls: ['<all_urls>'], types: ['xmlhttprequest', 'other']},
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') hlsCache.delete(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => hlsCache.delete(tabId));

// ─── Notify ────────────────────────────────────────────────────────
function notify(title, msg) {
  chrome.notifications.create('mpvise', {
    type: 'basic',
    iconUrl: 'icons/play-button-128.png',
    title,
    message: String(msg).slice(0, 200),
    priority: 1,
  });
}

// ─── URL Resolution ──────────────────────────────────────────────
function resolveUrl(info, tab) {
  if (info.linkUrl) return info.linkUrl;
  const src = info.srcUrl;
  if (src && !src.startsWith('blob:') && !src.startsWith('data:')) return src;
  return tab.url;
}

// ─── Play ──────────────────────────────────────────────────────
async function play(url, referer, tabId = null) {
  if (!url || url.startsWith('chrome://') || url.startsWith('about:')) {
    notify('MPVise', 'Cannot play this page.'); return;
  }

  const usingPageUrl = url === referer;
  const streams = usingPageUrl && tabId !== null ? hlsCache.get(tabId) : null;
  const target = streams?.size ? [...streams][0] : url;
  const direct = target !== url;

  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/ping`, {signal: AbortSignal.timeout(2000)});
    if (!r.ok) throw new Error();
  } catch {
    notify('MPVise — Offline', 'Run: mpvise start'); return;
  }

  notify('MPVise', direct ? 'Playing HLS stream…' : 'Resolving…');

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/play`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: target, referer, direct}),
      signal: AbortSignal.timeout(30000),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok) {
      notify('MPVise — Playing', body.browser ? `${body.browser} cookies` : '');
    } else {
      notify('MPVise — Failed', body.error || `HTTP ${resp.status}`);
    }
  } catch (e) {
    notify('MPVise — Error', e.name === 'AbortError' ? 'Timed out' : e.message);
  }
}

// ─── Context Menu ────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'play',
    title: 'Play with MPVise',
    contexts: ['page', 'link', 'video', 'audio'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  play(resolveUrl(info, tab), tab.url, tab.id);
});

// ─── Icon Click ────────────────────────────────────────────────
chrome.action.onClicked.addListener(tab => {
  play(tab.url, tab.url, tab.id);
});