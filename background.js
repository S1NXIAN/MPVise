const PORT = 8765;

const ICON = 'icons/play-button-128.png';
const STOP_ICON = 'icons/stop-128.png';

function notify(title, msg = '') {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: ICON,
    title,
    message: msg,
    priority: 1
  });
}

async function checkServer() {
  try {
    const resp = await fetch(`http://localhost:${PORT}/ping`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function sendToServer(url, useFallback = false) {
  const serverOk = await checkServer();
  if (!serverOk) {
    notify('Server Offline', 'Start: python3 launcher.py');
    return;
  }

  try {
    const resp = await fetch(`http://localhost:${PORT}/play`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url, fallback: useFallback})
    });
    const data = await resp.json();
    if (data.failed) {
      notify('Playback Failed', 'Could not extract video. Site not supported.');
    } else {
      notify('Playing on MPV');
    }
  } catch {
    notify('Playing on MPV');
  }
}

function createContextMenus() {
  chrome.contextMenus.create({
    id: 'play-page',
    title: 'Play with MPVise',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'play-link',
    title: 'Play with MPVise',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*']
  });
  chrome.contextMenus.create({
    id: 'play-video',
    title: 'Play with MPVise',
    contexts: ['video']
  });
}

chrome.runtime.onInstalled.addListener(createContextMenus);

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.url.includes('.m3u8') && d.tabId > 0) {
    sniffM3u8(d.url, d.tabId);
  }
}, {urls: ['<all_urls>']});

async function sniffM3u8(url, tabId) {
  try {
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) });
    const text = await resp.text();
    const head = text.slice(0, 1024);
    if (!head.includes('#EXT-X-STREAM-INF')) return;
  } catch {
    return;
  }

  chrome.storage.local.get(['m3u8s'], r => {
    const data = r.m3u8s || {};
    const cached = data[tabId] || [];
    if (!cached.includes(url)) {
      cached.push(url);
      data[tabId] = cached;
      chrome.storage.local.set({m3u8s: data});
      chrome.action.setBadgeText({text: String(cached.length), tabId});
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    chrome.storage.local.get(['m3u8s'], r => {
      const data = r.m3u8s || {};
      data[tabId] = [];
      chrome.storage.local.set({m3u8s: data});
      chrome.action.setBadgeText({text: '', tabId});
    });
  }
});

chrome.tabs.onActivated.addListener(i => {
  chrome.storage.local.get(['m3u8s'], r => {
    const data = r.m3u8s || {};
    const cached = data[i.tabId] || [];
    chrome.action.setBadgeText({text: cached.length ? String(cached.length) : '', tabId: i.tabId});
  });
});

chrome.tabs.onRemoved.addListener(t => {
  chrome.storage.local.get(['m3u8s'], r => {
    const data = r.m3u8s || {};
    delete data[t];
    chrome.storage.local.set({m3u8s: data});
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url = null;
  
  if (info.menuItemId === 'play-page') {
    url = tab.url;
  } else if (info.menuItemId === 'play-link') {
    url = info.linkUrl;
  } else if (info.menuItemId === 'play-video') {
    url = info.srcUrl || tab.url;
  }

  if (!url) {
    notify('No Video', 'No video URL found');
    return;
  }

  await sendToServer(url, true);
});

chrome.action.onClicked.addListener(async (tab) => {
  const serverOk = await checkServer();
  if (!serverOk) {
    chrome.action.setIcon({path: STOP_ICON, tabId: tab.id});
    notify('Server Offline', 'Start: python3 launcher.py');
    return;
  }

  chrome.action.setIcon({path: ICON, tabId: tab.id});

  if (!tab.url) {
    notify('No Video', 'No page URL');
    return;
  }

  const result = await chrome.storage.local.get(['m3u8s']);
  const data = result.m3u8s || {};
  const cached = data[tab.id] || [];

  if (cached.length > 0) {
    await sendToServer(cached[0], false);
  } else {
    await sendToServer(tab.url, true);
  }
});