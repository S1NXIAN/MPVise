'use strict';

// ═══════════════════════════════════════════════════════
// CONFIG (loaded from daemon at startup)
// ═══════════════════════════════════════════════════════

const CONFIG = {
  DEFAULT_PORT: 8765,
  TIMEOUT_PING: 2000,
  TIMEOUT_VALIDATE: 4000,
  TIMEOUT_PLAY: 35000,
};

// ═══════════════════════════════════════════════════════
// HLS CACHE MANAGER
// ═══════════════════════════════════════════════════════

const HLS = {
  cache: new Map(),
  validating: new Set(),

  isValidating(url) {
    return this.validating.has(url);
  },

  addValidation(url) {
    this.validating.add(url);
  },

  removeValidation(url) {
    this.validating.delete(url);
  },

  hasStream(tabId) {
    return this.cache.has(tabId);
  },

  getStreams(tabId) {
    return this.cache.get(tabId) || null;
  },

  addStream(tabId, url) {
    if (!this.cache.has(tabId)) this.cache.set(tabId, new Set());
    this.cache.get(tabId).add(url);
  },

  clear(tabId) {
    this.cache.delete(tabId);
  },

  clearAll() {
    this.cache.clear();
  },
};

// ─── Sniffer ──────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  ({ url, tabId }) => {
    try {
      if (!tabId || !url.includes('.m3u8')) return;
      if (HLS.isValidating(url)) return;
      HLS.addValidation(url);
      fetch(url, {
        headers: { Range: 'bytes=0-2047' },
        signal:  AbortSignal.timeout(CONFIG.TIMEOUT_VALIDATE),
      })
        .then(r => r.text())
        .then(text => {
          if (!text.includes('#EXT-X-STREAM-INF')) return;
          HLS.addStream(tabId, url);
        })
        .catch(e => console.error('[mpvise] m3u8 validation failed:', url, e.message))
        .finally(() => HLS.removeValidation(url));
    } catch (_) {}
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
);

// ─── Cache Cleanup ──────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') HLS.clear(tabId);
});

chrome.tabs.onRemoved.addListener(tabId => HLS.clear(tabId));

// ═══════════════════════════════════════════════════════
// NOTIFIER
// ═══════════════════════════════════════════════════════

const Notify = {
  create(title, msg) {
    chrome.notifications.create('mpvise', {
      type:     'basic',
      iconUrl:  'icons/play-button-128.png',
      title,
      message:  String(msg).slice(0, 200),
      priority: 1,
    });
  },

  playing(msg) {
    this.create('MPVise — Playing ▶', msg);
  },

  resolving() {
    this.create('MPVise', 'Resolving via yt-dlp…');
  },

  direct() {
    this.create('MPVise', 'Playing HLS stream…');
  },

  offline() {
    this.create('MPVise — Offline', 'Run: mpvise start');
  },

  invalidPage() {
    this.create('MPVise', 'Cannot play this page.');
  },

  failed(msg) {
    this.create('MPVise — Failed', msg);
  },

  error(msg) {
    this.create('MPVise — Error', msg);
  },
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
      const r = await fetch(`http://127.0.0.1:${port}/config`, {
        signal: AbortSignal.timeout(CONFIG.TIMEOUT_PING),
      });
      if (r.ok) {
        const cfg = await r.json();
        this._port = cfg.port || port;
        chrome.storage.local.set({ mpvise_port: this._port });
        console.log('[mpvise] config loaded, port:', this._port);
        return true;
      }
    } catch (_) {}
    return false;
  },

  async getConfig() {
    let stored = { mpvise_port: null };
    try {
      stored = await chrome.storage.local.get('mpvise_port');
    } catch (_) {}
    const ports = [stored.mpvise_port, CONFIG.DEFAULT_PORT].filter(Boolean);
    for (const port of ports) {
      if (port && await this._tryPort(port)) return;
    }
    console.log('[mpvise] daemon not running');
  },

  async ping() {
    const r = await fetch(`${this.url}/ping`, {
      signal: AbortSignal.timeout(CONFIG.TIMEOUT_PING),
    });
    if (!r.ok) throw new Error();
  },

  async play(url, referer, direct) {
    const resp = await fetch(`${this.url}/play`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, referer, direct }),
      signal:  AbortSignal.timeout(CONFIG.TIMEOUT_PLAY),
    });
    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, body };
  },
};

// ═══════════════════════════════════════════════════════
// PLAY CONTROLLER
// ═══════════════════════════════════════════════════════

const Play = {
  resolveUrl(info, tab) {
    try {
      if (info.linkUrl) return info.linkUrl;
      const src = info.srcUrl;
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) return src;
      return tab?.url || '';
    } catch (_) {
      return '';
    }
  },

  isPlayable(url) {
    if (!url) return false;
    if (url.startsWith('chrome://')) return false;
    if (url.startsWith('about:')) return false;
    return true;
  },

  getTarget(url, referer, tabId) {
    const usingPageUrl = url === referer;
    const streams = usingPageUrl && tabId !== null ? HLS.getStreams(tabId) : null;
    const target = streams?.size ? [...streams][0] : url;
    const direct = target !== url;
    return { target, direct };
  },

  async play(url, referer, tabId = null) {
    if (!this.isPlayable(url)) {
      Notify.invalidPage();
      return;
    }

    const { target, direct } = this.getTarget(url, referer, tabId);

    try {
      await Daemon.ping();
    } catch {
      Notify.offline();
      return;
    }

    direct ? Notify.direct() : Notify.resolving();

    try {
      const { ok, status, body } = await Daemon.play(target, referer, direct);
      if (ok) {
        Notify.playing(target.slice(0, 120));
      } else {
        Notify.failed(body.error || `HTTP ${status}`);
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Timed out (35 s)' : (e.message || String(e));
      Notify.error(msg);
    }
  },
};

// ═══════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(() => {
  Daemon.getConfig();
  chrome.contextMenus.create({
    id:       'play',
    title:    'Play with MPVise',
    contexts: ['page', 'link', 'video', 'audio'],
  });
});

// Load config when extension starts (also on browser restart)
Daemon.getConfig().catch(() => {});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  Play.play(Play.resolveUrl(info, tab), tab.url, tab.id);
});

chrome.action.onClicked.addListener(tab => {
  Play.play(tab.url, tab.url, tab.id);
});