let m3u8Cache = {};
const PORT = 8765;

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/play-button-128.png',
    title,
    message: message.slice(0, 100),
    priority: 1
  });
}

async function updateBadge(tabId) {
  const hasStreams = (m3u8Cache[tabId] || []).length > 0;
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: hasStreams ? '!' : '' }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#34d399' })
  ]);
}

async function updateYtDlpMenu(tabId) {
  const hasStreams = (m3u8Cache[tabId] || []).length > 0;
  try {
    await chrome.contextMenus.update('play-ytdlp', { visible: hasStreams });
  } catch (_) {}
}

// Content-aware Sniffer
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const tabId = details.tabId;
    if (tabId <= 0 || !url.includes('.m3u8')) return;

    // Fetch and check if it's a true master playlist
    fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) })
      .then(resp => resp.text())
      .then(text => {
        const isMaster = text.startsWith('#EXTM3U') && text.includes('#EXT-X-STREAM-INF') && text.includes('BANDWIDTH=') && !text.includes('#EXTINF') && !text.includes('#EXT-X-TARGETDURATION');
        
        if (isMaster) {
          if (!m3u8Cache[tabId]) m3u8Cache[tabId] = [];
          if (!m3u8Cache[tabId].includes(url)) {
            m3u8Cache[tabId].push(url);
            updateBadge(tabId);
            updateYtDlpMenu(tabId);
          }
        }
      })
      .catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "other"] }
);

// Cleanup on tab close/refresh
chrome.tabs.onRemoved.addListener((tabId) => delete m3u8Cache[tabId]);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete m3u8Cache[tabId];
    updateBadge(tabId);
    updateYtDlpMenu(tabId);
  }
});

// Sync menu visibility when the user switches tabs
chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateYtDlpMenu(tabId);
});

async function sendToServer(url, fallback = true, referer = null) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    const response = await fetch(`http://127.0.0.1:${PORT}/play`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url, fallback, referer}),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const err = await response.json();
      notify('Playback Failed', err.error || 'Unknown error');
    } else {
      notify('Playing', 'Video sent to mpv');
    }
  } catch (e) {
    notify('Error', 'Server not running? Run: python3 launcher.py');
  }
}

// Context menu registration
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'play',
    title: 'Play with MPVise',
    contexts: ['link', 'video', 'page']
  });

  // Extension-icon right-click menu — hidden until .m3u8 is detected
  chrome.contextMenus.create({
    id: 'play-ytdlp',
    title: 'Play on yt-dlp',
    contexts: ['action'],
    visible: false
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // "Play on yt-dlp" — always uses yt-dlp fallback
  if (info.menuItemId === 'play-ytdlp') {
    sendToServer(tab.url, true, tab.url);
    return;
  }

  // "Play with MPVise" — prefer detected stream, else direct play
  const streams = m3u8Cache[tab.id] || [];
  if (streams.length) {
    sendToServer(streams[0], false, tab.url);
    return;
  }
  let targetUrl = info.linkUrl || info.srcUrl || tab.url;
  if (targetUrl.startsWith('blob:') || targetUrl.startsWith('data:')) targetUrl = tab.url;
  sendToServer(targetUrl, true, tab.url);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || tab.url.startsWith('chrome://')) return notify('Error', 'Invalid page');
  const streams = m3u8Cache[tab.id] || [];
  if (streams.length) return sendToServer(streams[0], false, tab.url);
  sendToServer(tab.url, true, tab.url);
});
