const PORT = 8765;
const ICON = 'icons/play-button-128.png';
const STOP_ICON = 'icons/stop-128.png';
let urls = {};

function notify(title, msg = '') {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: ICON,
    title,
    message: msg,
    priority: 1
  });
}

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.url.includes('.m3u8') && d.tabId > 0) {
    urls[d.tabId] = urls[d.tabId] || new Set();
    urls[d.tabId].add(d.url);
    chrome.action.setBadgeText({ text: String(urls[d.tabId].size), tabId: d.tabId });
  }
}, { urls: ['<all_urls>'] });

chrome.tabs.onActivated.addListener(i => {
  const u = urls[i.tabId];
  chrome.action.setBadgeText({ text: u?.size ? String(u.size) : '', tabId: i.tabId });
});

chrome.tabs.onRemoved.addListener(t => delete urls[t]);

chrome.action.onClicked.addListener(async t => {
  let serverOk = false;
  try {
    const resp = await fetch(`http://localhost:${PORT}/ping`);
    serverOk = resp.ok;
  } catch {}

  if (!serverOk) {
    chrome.action.setIcon({ path: STOP_ICON, tabId: t.id });
    notify('Server Offline', 'Start: python3 launcher.py');
    return;
  }

  chrome.action.setIcon({ path: ICON, tabId: t.id });

  const u = t.url || '';

  if (u.includes('youtube.com') || u.includes('youtu.be')) {
    const match = u.match(/[?&]v=([a-zA-Z0-9_-]+)|youtu\.be\/([a-zA-Z0-9_-]+)/);
    if (match) {
      const vid = match[1] || match[2];
      fetch(`http://localhost:${PORT}/play`, { 
        method: 'POST', 
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({url:`https://youtu.be/${vid}`})
      });
      notify('Playing on MPV');
    } else {
      notify('No Video Selected', 'Open a YouTube video first');
    }
    return;
  }

  const arr = urls[t.id];
  if (!arr || !arr.size) {
    notify('No M3U8', 'No m3u8 URL found on this page');
    return;
  }
  fetch(`http://localhost:${PORT}/play`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({url: Array.from(arr)[0]})
  });
  notify('Playing on MPV');
});