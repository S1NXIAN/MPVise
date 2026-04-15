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

async function getM3u8s() {
  const result = await chrome.storage.local.get(['m3u8s']);
  return result.m3u8s || {};
}

async function setM3u8s(data) {
  chrome.storage.local.set({m3u8s: data});
}

async function updateBadge(tabId) {
  const data = await getM3u8s();
  const cached = data[tabId] || [];
  chrome.action.setBadgeText({text: cached.length ? String(cached.length) : '', tabId});
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
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'playWithMPVise',
      title: 'Play with MPVise',
      contexts: ['page', 'link', 'video']
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenus);
createContextMenus();

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.url.includes('.m3u8') && d.tabId > 0) {
    sniffM3u8(d.url, d.tabId);
  }
}, {urls: ['<all_urls>']});

async function sniffM3u8(url, tabId) {
  try {
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    const text = await resp.text();

    const streamIdx = text.indexOf('#EXT-X-STREAM-INF');
    const extinfIdx = text.indexOf('#EXTINF');
    const isMaster = streamIdx !== -1 && (extinfIdx === -1 || streamIdx < extinfIdx);
    if (!isMaster) return;
  } catch {
    return;
  }

  const data = await getM3u8s();
  const cached = data[tabId] || [];
  if (!cached.includes(url)) {
    cached.push(url);
    data[tabId] = cached;
    await setM3u8s(data);
    chrome.action.setBadgeText({text: String(cached.length), tabId});
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    const data = await getM3u8s();
    data[tabId] = [];
    await setM3u8s(data);
    chrome.action.setBadgeText({text: '', tabId});
  }
});

chrome.tabs.onActivated.addListener(i => updateBadge(i.tabId));

chrome.tabs.onRemoved.addListener(async t => {
  const data = await getM3u8s();
  delete data[t];
  await setM3u8s(data);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'playWithMPVise') return;

  if (!tab) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  }

  const url = await resolveUrl(info, tab);
  if (!url) {
    notify('No Video', 'No video URL found');
    return;
  }

  await sendToServer(url, true);
});

async function resolveUrl(info, tab) {
  if (info.linkUrl) return info.linkUrl;
  if (info.srcUrl) return info.srcUrl;
  // Page background: use detected master playlist or page URL
  const data = await getM3u8s();
  const cached = data[tab.id] || [];
  return cached.length > 0 ? cached[0] : tab.url;
}

async function handleActionClick(tab) {
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

  const data = await getM3u8s();
  const cached = data[tab.id] || [];

  if (cached.length > 0) {
    await sendToServer(cached[0], false);
  } else {
    await sendToServer(tab.url, true);
  }
}

chrome.action.onClicked.addListener(handleActionClick);

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'play-with-mpvise') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) handleActionClick(tab);
  }
});