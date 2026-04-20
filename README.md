<div align="center">
  <img src="icons/play-button.png" alt="MPVise logo" width="96" />
  <h1>MPVise</h1>
  <p>A Chrome extension and local daemon that sends any web video to <a href="https://mpv.io">mpv</a> with one click.</p>

  ![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
  ![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue)
  ![License: MIT](https://img.shields.io/badge/License-MIT-green)
</div>

---

Right-click any page, link, or video element and choose **Play with MPVise**. The extension hands the URL to a lightweight local daemon, which runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) to extract the stream and opens it in mpv — all with real-time status updates in your browser.

Works on [every site yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) (YouTube, Twitch, Twitter/X, Vimeo, and 1 000+ more). On pages that expose raw HLS streams (`.m3u8`), the stream goes straight to mpv without extraction delay.

## How it works

```
Browser                        Daemon (127.0.0.1:8765)
  │                                    │
  ├─ webRequest sees .m3u8 ──────────► │ (sniffed; direct play)
  │                                    │
  └─ right-click / icon click ────────►│
        URL is a raw stream?  YES ─────► mpv  ⚡ instant
        URL is a raw stream?  NO  ──────► yt-dlp (parallel browser tests)
                                              └──► mpv
```

- **HLS sniffing** — the extension intercepts `.m3u8` network requests and validates them. Confirmed master playlists are cached per tab and sent to mpv with a `direct` flag, skipping yt-dlp.
- **Parallel extraction** — when yt-dlp is needed, all configured browser cookie sources are tried simultaneously. The daemon streams progress updates (e.g., "Checking Chrome cookies...") back to your browser in real-time.
- **Browser Hinting** — the extension automatically detects your current browser (Vivaldi, Brave, Edge, etc.) and hints the daemon to prioritize it, ensuring the fastest possible cookie extraction.
- **Smart configuration** — settings are merged from defaults, `~/.config/mpvise/mpvise.conf`, and environment variables.

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
./mpvise --start
```

That's it. Right-click any page and choose **Play with MPVise**.

## Usage

| Action | Result |
|---|---|
| Right-click a page → *Play with MPVise* | Plays the page (or cached HLS stream) |
| Right-click a link → *Play with MPVise* | Plays that specific URL |
| Right-click a video element → *Play with MPVise* | Plays the video's source |
| Click the extension icon | Plays the current tab |

### Configuration

The configuration file `~/.config/mpvise/mpvise.conf` is **automatically created** on your first run. It uses a standard `key=value` format (like `mpv.conf`).

Example:
```ini
port=8765
mpv_args=--fs --ontop
ytdlp_format=bestvideo+bestaudio/best
browsers=(chrome, vivaldi, firefox)
```

**Environment Overrides:**
- `MPVISE_PORT`: Change the daemon port (default: 8765)
- `MPVISE_MPV_SOCKET`: Path to mpv IPC socket
- `MPVISE_BROWSERS`: Comma-separated list of browsers to check for cookies

### Daemon CLI

```bash
./mpvise --start      # start in background
./mpvise --stop       # stop
./mpvise --status     # show status
./mpvise --logs       # view recent logs
./mpvise --run        # run in foreground (debug)
```

## Tips

**Keep mpv on top in a corner** — add to `~/.config/mpv/mpv.conf`:

```ini
ontop=yes
border=no
window-scale=0.4
geometry=100%:100%
```

**Keep yt-dlp updated** — site extractors change frequently:

```bash
yt-dlp -U
```
