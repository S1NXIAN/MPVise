# <img src="icons/play-button-48.png" align="center" width="32"> MPVise

> Play any web video directly in **mpv** with automatic HLS stream detection, a stream-picker popup, and `yt-dlp` fallback — all with a single click.

MPVise is a Chrome extension + local Python daemon that bridges your browser with [mpv](https://mpv.io/). It sniffs HLS master playlists in real time, displays a numeric badge, and offers multiple ways to trigger playback — including a stream picker when multiple streams are found.

---

## ✨ Features

| Feature | Detail |
|---|---|
| 🎯 **Smart Detection** | Range-limited fetch + compiled regex; validates master playlists without downloading full files |
| 🔢 **Numeric Badge** | Shows stream count (1–9, then "9+"); colour-coded green/amber/red |
| 🪟 **Stream Picker** | Multi-stream popup lets you choose which stream to play |
| 🔗 **Context Menus** | Right-click page/link/video → **Play with MPVise**; right-click icon → **Play on yt-dlp** |
| 🍪 **Cookie Sync** | Parallel yt-dlp extraction across all installed browsers; returns the first success |
| ⚡ **URL Cache** | 5-minute in-memory cache avoids re-running yt-dlp for the same URL |
| 🔁 **Auto Retry** | Exponential backoff (3 attempts) with a **Retry** button in error notifications |
| 🩺 **Health Check** | Pings daemon before every play; shows actionable notification if offline |
| 📋 **Rich CLI** | `start` / `stop` / `restart` / `status` / `logs` / `run` subcommands |
| 🪵 **Rotating Logs** | 5 MB max log file, 2 backups, structured timestamps |

---

## 📋 Requirements

- **Python 3.11+**
- **[mpv](https://mpv.io/)** — media player
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — stream extraction
- **[aiohttp](https://docs.aiohttp.org/)** — async HTTP server (`pip install aiohttp`)
- **Chrome / Chromium 108+**

---

## 🚀 Installation

### Linux

```bash
# 1. Install system deps
sudo apt install mpv          # or: pacman -S mpv / dnf install mpv
pip install --user yt-dlp aiohttp

# 2. Clone the repo
git clone https://github.com/youruser/mpvise
cd mpvise

# 3. Start the daemon
python3 launcher.py start

# 4. Load the extension
# Open chrome://extensions → Enable Developer Mode → Load Unpacked → select this folder
```

### macOS

```bash
brew install mpv
pip3 install yt-dlp aiohttp

git clone https://github.com/youruser/mpvise && cd mpvise
python3 launcher.py start
```

> [!TIP]
> To auto-start on login, create a launchd plist:
> ```bash
> cat > ~/Library/LaunchAgents/mpvise.plist << EOF
> <?xml version="1.0" encoding="UTF-8"?>
> <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
> <plist version="1.0"><dict>
>   <key>Label</key><string>mpvise</string>
>   <key>ProgramArguments</key>
>   <array><string>python3</string><string>/path/to/mpvise/launcher.py</string><string>run</string></array>
>   <key>RunAtLoad</key><true/>
>   <key>KeepAlive</key><true/>
> </dict></plist>
> EOF
> launchctl load ~/Library/LaunchAgents/mpvise.plist
> ```

### Windows

```powershell
# Install mpv and add to PATH: https://mpv.io/installation/
# Install yt-dlp: winget install yt-dlp.yt-dlp
pip install aiohttp

git clone https://github.com/youruser/mpvise
cd mpvise
python launcher.py start
```

> [!NOTE]
> On Windows, `launcher.py start` spawns the daemon as a `DETACHED_PROCESS` so it keeps running after the console closes. Use `python launcher.py stop` to shut it down cleanly.

---

## 🛠️ Usage

### Daemon CLI

```bash
python3 launcher.py start     # Start in background
python3 launcher.py stop      # Send SIGTERM, wait, then SIGKILL if needed
python3 launcher.py restart   # Stop + start
python3 launcher.py status    # Running state + last 5 log lines
python3 launcher.py logs      # Print last 100 log lines
python3 launcher.py logs -f   # Follow live log output
python3 launcher.py run       # Foreground mode (Ctrl+C to stop)
```

### Extension

| Action | Behaviour |
|---|---|
| **Click icon** (0 streams) | Sends page URL to yt-dlp for resolution |
| **Click icon** (1 stream) | Plays the detected HLS stream directly |
| **Click icon** (2+ streams) | Opens the **stream picker popup** |
| **Right-click icon** → *Play on yt-dlp* | Sends current page URL to yt-dlp (visible only when a stream is detected) |
| **Right-click page/link/video** → *Play with MPVise* | Plays detected HLS stream or falls back to yt-dlp |

### Badge States

| Badge | Meaning |
|---|---|
| *(empty)* | No streams detected |
| `1`…`9` / `9+` | Stream count — green |
| Amber | yt-dlp extraction in progress |
| Red | Error occurred |

### Notifications

| Notification | When |
|---|---|
| *Stream Detected* | A new HLS master playlist is found |
| *Resolving Stream…* | yt-dlp extraction started |
| *Now Playing* | mpv launched / queued successfully |
| *Playback Failed* + **Retry** button | Any error; click Retry to replay last request |
| *Daemon Offline* | `/ping` failed before sending play request |

---

## ⚙️ Configuration

Copy `config.example.json` to `~/.config/mpvise/config.json` and edit:

```jsonc
{
  "port":              8765,          // TCP port the extension talks to
  "mpv_socket":        "/tmp/mpvsocket", // MPV JSON-IPC socket path
  "mpv_args":          [],            // Extra mpv flags, e.g. ["--volume=80"]
  "ytdlp_format":      "best[height<=1080]/best",
  "browsers":          ["vivaldi", "chrome", "firefox", "brave"],
  "cache_ttl_seconds": 300,           // How long to cache extracted URLs
  "log_max_bytes":     5242880,       // Log rotation size (5 MB)
  "ytdlp_timeout":     30,            // Per-browser yt-dlp timeout in seconds
  "rate_limit_rps":    10             // Max /play requests per second per IP
}
```

**Environment variable overrides:**
```bash
MPVISE_PORT=9000 MPVISE_SOCKET=/run/mpv.sock python3 launcher.py run
```

---

## 🔍 Daemon Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/ping` | GET | Returns `{"ok":true,"uptime_seconds":N}` |
| `/status` | GET | Detailed status: cache stats, dep check, last error |
| `/play` | POST | Trigger playback — see body schema below |

**POST /play** body:
```json
{
  "url":      "https://example.com/watch?v=...",
  "fallback": true,
  "referer":  "https://example.com"
}
```

---

## 🏗️ How It Works

```
Browser Network Request (.m3u8)
        │
        ▼
 background.js (webRequest)
  → fetch first 4 KB (Range: bytes=0-4095)
  → validate master playlist regex
  → deduplicate via Set, update badge + context menu
        │
        ▼ (user clicks / right-clicks)
 sendToServer()
  → GET /ping  ──► daemon healthy?  ──NO──► error notification
  → POST /play  (with 3-attempt exponential backoff)
        │
        ▼
  daemon.py handle_play()
  ├── is_direct_media(url)?  ──YES──► launch_mpv directly
  └── yt-dlp extraction (parallel across browsers)
            │
            ▼
       launch_mpv()
       ├── _mpv_socket_alive()?  ──YES──► JSON-IPC loadfile append-play
       └── spawn new detached mpv process
```

---

## 🐛 Troubleshooting

### "Daemon Offline" notification
```bash
# Check if the daemon is running
python3 launcher.py status

# Start it
python3 launcher.py start

# If it won't start, check logs
python3 launcher.py logs
```

### yt-dlp cookie extraction fails
- Make sure the browser is **closed** before extraction (some browsers lock the cookie DB while open).
- Update yt-dlp: `pip install -U yt-dlp`
- Try running manually: `yt-dlp --cookies-from-browser chrome -g "https://example.com"`

### mpv doesn't launch
```bash
which mpv          # Confirm it's on PATH
mpv --version      # Confirm it runs
python3 launcher.py logs   # Check for "mpv not found" errors
```

### Badge doesn't update after reload
- Some SPAs don't trigger a full page load; the badge clears only on `status: 'loading'`.
- Hard-reload the page (Ctrl+Shift+R) to reset stream detection.

### Multiple mpv windows open
- MPVise first checks if an existing mpv socket is alive before launching a new instance.
- If the socket is stale (crashed mpv), the file may persist — delete `/tmp/mpvsocket` manually.

---

## 🗺️ Roadmap

- **Systemd unit** for Linux auto-start without launchd/cron
- **DASH / Smooth Streaming** detection support
- **Queue manager** popup showing all streams across all tabs
- **VLC / IINA** player support via config

---

*MPVise v3.0 — blazingly fast, production-grade.*
