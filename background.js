'use strict';

const PORT = 8765;
const hlsCache = new Map();

const BROWSER_HINT = (() => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('vivaldi')) return 'vivaldi';
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('brave')) return 'brave';
  if (ua.includes('opera') || ua.includes('opr/')) return 'opera';
  if (ua.includes('chrome')) return 'chrome';
  if (ua.includes('firefox')) return 'firefox';
  return null;
})();

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
  
  let notificationId = 'mpvise';

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/play`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: target, referer, direct, hint: BROWSER_HINT}),
    });

    if (!resp.body) throw new Error('No response body');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const statusMap = {
            'using_cache': (data) => `Fast-loading ${data.browser} session...`,
            'racing_browsers': (data) => `Racing ${data.count || (data.browsers ? data.browsers.length : '?')} browsers for cookies...`,
            'resolving_cookies': (data) => `Resolving cookies in ${data.browser}...`,
            'testing_browser': (data) => `Checking ${data.browser} cookies...`,
          };
          if (event.error) {
            notify('MPVise — Failed', event.error);
          } else if (statusMap[event.status]) {
            notify('MPVise', statusMap[event.status](event));
          } else if (event.status === 'launching') {
            notify('MPVise', 'Launching mpv player...');
          } else if (event.status === 'playing') {
            const msg = event.browser ? `Playing via ${event.browser} cookies` : (event.direct ? 'Playing direct stream' : 'Playing (no cookies needed)');
            notify('MPVise', msg);
          }
        } catch (e) {
          console.error('Failed to parse event:', line);
        }
      }
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