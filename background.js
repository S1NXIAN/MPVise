let m3u8Cache = {};
const PORT = 8765;

function isYoutube(url) {
  return url && (url.includes('youtube.com') || url.includes('youtu.be'));
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/play-button-128.png',
      title,
      message: message.slice(0, 100),
      priority: 1
    });
  } catch(e) {}
}

async function updateBadge(tabId) {
  const streams = m3u8Cache[tabId] || [];
  const count = streams.length;
  await chrome.action.setBadgeText({
    tabId: tabId,
    text: count > 0 ? '!' : ''
  });
  await chrome.action.setBadgeBackgroundColor({
    tabId: tabId,
    color: '#34d399'
  });
}

// Sniffer
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const tabId = details.tabId;
    
    if (tabId < 0) return;
    
    // Filter for potential master playlists, ignore common segment patterns
    if (url.includes('.m3u8') && !url.includes('seg-') && !url.includes('fragment')) {
      if (!m3u8Cache[tabId]) m3u8Cache[tabId] = [];
      if (!m3u8Cache[tabId].includes(url)) {
        m3u8Cache[tabId].push(url);
        updateBadge(tabId);
      }
    }
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "other"] }
);

// Cleanup on tab close/refresh
chrome.tabs.onRemoved.addListener((tabId) => delete m3u8Cache[tabId]);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete m3u8Cache[tabId];
    updateBadge(tabId);
  }
});

async function sendToServer(url, fallback = true) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    const response = await fetch(`http://127.0.0.1:${PORT}/play`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url, fallback}),
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

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'play',
    title: 'Play with MPVise',
    contexts: ['link', 'video', 'page']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // 1. Check if we have detected streams for this tab
  const streams = m3u8Cache[tab.id] || [];
  if (streams.length > 0) {
    sendToServer(streams[0], false); // Play direct m3u8
    return;
  }

  // 2. Proceed with current process
  let url = info.linkUrl || info.srcUrl || tab.url;
  if (!url) return;
  
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    if (isYoutube(tab.url)) url = tab.url;
    else {
      notify('Error', 'Cannot play blob URLs');
      return;
    }
  }
  
  sendToServer(url, true);
});

// Extension button
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || tab.url.startsWith('chrome://')) {
    notify('Error', 'Invalid page');
    return;
  }

  // 1. Check if we have detected streams
  const streams = m3u8Cache[tab.id] || [];
  if (streams.length > 0) {
    sendToServer(streams[0], false);
    return;
  }

  // 2. Proceed with current process
  sendToServer(tab.url, true);
});
