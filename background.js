const SOCKET_PATH = '/home/xian/.config/mpvise/mpvise.sock'; // Adjust username or make dynamic

let m3u8Cache = {};
const PORT = 8765; // Fallback to TCP if needed

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

// Fast Unix socket communication via native messaging-style fetch
// Since Chrome can't do Unix sockets directly, we use HTTP fallback on localhost
// or you can use a native helper. For now, optimized TCP:

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
  let url = info.linkUrl || info.srcUrl || tab.url;
  
  if (!url) return;
  
  // If blob/data URL on YouTube, use page URL
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
  sendToServer(tab.url, true);
});
