'use strict';

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════

const CONFIG = {
  DEFAULT_PORT: 8765,
  TIMEOUT_PING: 2000,
  TIMEOUT_VALIDATE: 4000,
  TIMEOUT_PLAY: 35000,
};

// ═══════════════════════════════════════════════════════
// HLS CACHE
// ═══════════════════════════════════════════════════════

const HLS = {
  cache: new Map(),

  getStream(tabId) {
    return this.cache.get(tabId) || null;
  },

  addStream(tabId, url) {
    this.cache.set(tabId, url);
    chrome.action.setBadgeText({ text: '!', tabId });
  },

  clear(tabId) {
    this.cache.delete(tabId);
  },
};

// ─── Sniffer ──────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  ({ url, tabId }) => {
    if (!tabId || !url.includes('.m3u8')) return;
    fetch(url, { headers: { Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(CONFIG.TIMEOUT_VALIDATE) })
      .then(r => r.text())
      .then(text => {
        if (text.includes('#EXT-X-STREAM-INF')) {
          HLS.addStream(tabId, url);
        }
      })
      .catch(e => console.error('[mpvise] sniffer:', url, e.message));
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    HLS.clear(tabId);
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

// ═══════════════════════════════════════════════════════
// NOTIFIER
// ═══════════════════════════════════════════════════════

const Notify = {
  create(title, msg) {
    chrome.notifications.create('mpvise', { type: 'basic', iconUrl: 'icons/play-button-128.png', title, message: String(msg).slice(0, 200), priority: 1 });
  },
  playing(msg) { this.create('MPVise — Playing ▶', msg); },
  resolving() { this.create('MPVise', 'Resolving via yt-dlp…'); },
  direct() { this.create('MPVise', 'Playing HLS stream…'); },
  offline() { this.create('MPVise — Offline', 'Run: mpvise start'); },
  invalidPage() { this.create('MPVise', 'Cannot play this page.'); },
  failed(msg) { this.create('MPVise — Failed', msg); },
  error(msg) { this.create('MPVise — Error', msg); },
};

// ═══════════════════════════════════════════════════════
// DAEMON CLIENT
// ═══════════════════════════════════════════════════════

const Daemon = {
  _port: CONFIG.DEFAULT_PORT,

  get url() {
    return `http://127.0.0.1:${this._port}`;
  },

  async _tryPort(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(CONFIG.TIMEOUT_PING) });
      if (r.ok) {
        const cfg = await r.json();
        this._port = cfg.port || port;
        chrome.storage.local.set({ mpvise_port: this._port });
        return true;
      }
    } catch (_) {}
    return false;
  },

  async getConfig() {
    let stored = { mpvise_port: null };
    try { stored = await chrome.storage.local.get('mpvise_port'); } catch (_) {}
    const ports = stored.mpvise_port ? [stored.mpvise_port] : [CONFIG.DEFAULT_PORT];
    for (const port of ports) {
      if (await this._tryPort(port)) return;
    }
  },

  async ping() {
    const r = await fetch(`${this.url}/ping`, { signal: AbortSignal.timeout(CONFIG.TIMEOUT_PING) });
    if (!r.ok) throw new Error();
  },

  async play(url, referer, direct) {
    const resp = await fetch(`${this.url}/play`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, referer, direct }), signal: AbortSignal.timeout(CONFIG.TIMEOUT_PLAY) });
    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, body };
  },
};

// ═══════════════════════════════════════════════════════
// PLAY CONTROLLER
// ═══════════════════════════════════════════════════════

const Play = {
  resolveUrl(info, tab = {}) {
    return info.linkUrl || (info.srcUrl && !info.srcUrl.startsWith('blob:') && !info.srcUrl.startsWith('data:') ? info.srcUrl : tab?.url) || '';
  },

  isPlayable(url) {
    return url && !url.startsWith('chrome://') && !url.startsWith('about:');
  },

  getTarget(url, tabId) {
    const m3u8 = HLS.getStream(tabId);
    return { target: m3u8 || url, direct: !!m3u8 };
  },

  async play(url, referer, tabId = null) {
    if (!this.isPlayable(url)) return Notify.invalidPage();
    try { await Daemon.getConfig(), await Daemon.ping(); }
    catch { return Notify.offline(); }

    const { target, direct } = this.getTarget(url, tabId);
    direct ? Notify.direct() : Notify.resolving();

    try {
      const { ok, status, body } = await Daemon.play(target, referer, direct);
      ok ? Notify.playing(target.slice(0, 120)) : Notify.failed(body.error || `HTTP ${status}`);
    } catch (e) {
      Notify.error(e.name === 'AbortError' ? 'Timed out (35 s)' : e.message);
    }
  },
};

// ═══════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(() => {
  Daemon.getConfig();
  chrome.contextMenus.create({ id: 'play', title: 'Play with MPVise', contexts: ['page', 'link', 'video', 'audio'] });
  chrome.action.setBadgeBackgroundColor({ color: '#4a90d9' });
});

Daemon.getConfig().catch(() => {});

chrome.contextMenus.onClicked.addListener((info, tab) => Play.play(Play.resolveUrl(info, tab), tab.url, tab.id));

chrome.action.onClicked.addListener(tab => Play.play(tab.url, tab.url, tab.id));