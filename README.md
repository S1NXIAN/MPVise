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

- **HLS sniffing** — the extension intercepts `.m3u8` network requests and validates them (2 KB `Range` fetch). Confirmed master playlists are cached per tab and sent to mpv directly, without yt-dlp.
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

> [!IMPORTANT]
> Do **not** run any Python files from inside the extension folder before loading it. Python creates a `__pycache__` directory that Chrome will refuse to load. If it appears, delete it: `rm -rf __pycache__`

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

## Configuration

The daemon reads `~/.config/mpvise/config.json`. Copy the example to get started:

```bash
cp config.example.json ~/.config/mpvise/config.json
```

Key options:

| Key | Default | Description |
|---|---|---|
| `port` | `8765` | Port the daemon listens on |
| `ytdlp_format` | `best[height<=1080]/best` | yt-dlp format selector |
| `browsers` | `["vivaldi", "chrome", "firefox", "brave"]` | Cookie sources tried in parallel |
| `ytdlp_timeout` | `30` | Per-attempt timeout in seconds |

You can also override the port at runtime:

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

**Cookies improve success rates** — if a site requires login (Twitch subscriptions, age-gated content), make sure you are signed in with one of the browsers listed in `browsers`. yt-dlp will read cookies from the first browser that has a valid session.

**Keep yt-dlp updated** — site extractors change frequently:

```bash
yt-dlp -U
```

> [!NOTE]
> `PYTHONDONTWRITEBYTECODE=1` prevents Python from creating `__pycache__` in the extension directory. Add it to your shell profile to avoid the issue permanently:
> ```bash
> echo 'export PYTHONDONTWRITEBYTECODE=1' >> ~/.bashrc
> ```
