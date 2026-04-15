<div align="center">
  <img src="icons/play-button.png" alt="MPVise logo" width="96" />
  <h1>MPVise</h1>
  <p>A Chrome extension and local daemon that sends any web video to <a href="https://mpv.io">mpv</a> with one click.</p>

  ![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
  ![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue)
  ![License: MIT](https://img.shields.io/badge/License-MIT-green)
</div>

---

Right-click any page, link, or video element and choose **Play with MPVise**. The extension hands the URL to a lightweight local daemon, which runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) to extract the stream and opens it in mpv — all without leaving your browser.

Works on [every site yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) (YouTube, Twitch, Twitter/X, Vimeo, and 1 000+ more). On pages that expose raw HLS streams (`.m3u8`), the daemon is bypassed entirely and the stream goes straight to mpv in under a second.

## How it works

```
Browser                        Daemon (127.0.0.1:8765)
  │                                    │
  ├─ webRequest sees .m3u8 ──────────► │ (cached; sent direct)
  │                                    │
  └─ right-click / icon click ────────►│
        URL is a raw stream?  YES ─────► mpv  ⚡ instant
        URL is a raw stream?  NO  ──────► yt-dlp (parallel browser tries)
                                              └──► mpv
```

- **HLS sniffing** — the extension intercepts `.m3u8` network requests and validates them with a 2 KB `Range` fetch. Confirmed master playlists are cached per tab and sent to mpv directly, skipping yt-dlp entirely.
- **Parallel extraction** — when yt-dlp is needed, all configured browser cookie sources are tried simultaneously. The first successful result wins and the rest are cancelled.
- **Smart URL resolution** — right-clicking a specific link or video plays that URL; clicking the extension icon or page background uses the cached HLS stream if one was detected.

## Requirements

| Dependency | Notes |
|---|---|
| [mpv](https://mpv.io/installation/) | Must be on `PATH` |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) | Must be on `PATH`; keep it updated |
| Python 3.11+ | Daemon and launcher |
| [aiohttp](https://docs.aiohttp.org/) | `pip install aiohttp` |
| Chromium-based browser | Chrome, Vivaldi, Brave, Edge, etc. |

## Installation

### 1. Install Python dependencies

```bash
pip install aiohttp
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `MPVise` folder

### 3. Start the daemon

```bash
python3 launcher.py start
```

That's it. Right-click any page and choose **Play with MPVise**.

## Usage

| Action | Result |
|---|---|
| Right-click a page → *Play with MPVise* | Plays the page (or cached HLS stream) |
| Right-click a link → *Play with MPVise* | Plays that specific URL |
| Right-click a video element → *Play with MPVise* | Plays the video's source |
| Click the extension icon | Plays the current tab |

### Daemon CLI

```bash
python3 launcher.py start      # start in background
python3 launcher.py stop       # stop
python3 launcher.py restart    # restart
python3 launcher.py status     # show status + recent log
python3 launcher.py logs       # print last 100 log lines
python3 launcher.py logs -f    # follow log output (tail -f)
python3 launcher.py            # run in foreground
```

The daemon port defaults to `8765` and can be overridden at runtime:

```bash
MPVISE_PORT=9000 python3 launcher.py start
```

## Tips

**Keep mpv on top in a corner** — add to `~/.config/mpv/mpv.conf`:

```ini
ontop=yes
border=no
window-scale=0.4
geometry=100%:100%
```

**Cookies improve success rates** — if a site requires login (Twitch subscriptions, age-gated content), make sure you are signed in with one of the browsers yt-dlp checks (`vivaldi`, `chrome`, `chromium`, `firefox`, `brave`). yt-dlp will use the first browser that has a valid session.

**Keep yt-dlp updated** — site extractors change frequently:

```bash
yt-dlp -U
```
