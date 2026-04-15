# MPVise v2.0

Play videos directly on MPV from your browser. Works on any streaming site.

## Overview

MPVise is a Chrome extension that detects video streams and plays them on MPV. When an m3u8 stream is detected (common in HLS streaming), it plays directly. Otherwise, it uses yt-dlp to extract the stream URL from any webpage.

## Quick Start

```bash
# 1. Install dependencies
pip install yt-dlp

# 2. Start the server
python3 launcher.py

# 3. Load extension in Chrome
#    chrome://extensions/ → Developer mode → Load unpacked → Select MPVise folder
```

## Requirements

- Python 3
- [MPV](https://mpv.io/) media player
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)

## Usage

### Method 1: Extension Icon

1. Visit any video page
2. Badge shows the number of detected m3u8 streams
3. Click the extension icon to play the first detected stream (or current page URL as fallback)

### Method 2: Right-Click Context Menu

Right-click anywhere on the page and select **Play with MPVise**. Also works on links and video elements.

### Method 3: Server Commands

```bash
python3 launcher.py          # Start in foreground (Ctrl+C to stop)
python3 launcher.py --daemon # Start in background
python3 launcher.py --kill  # Stop the server
```

## How It Works

```
Chrome Extension ──▶ Daemon (yt-dlp) ──▶ MPV Player
```

1. **m3u8 Detection**: Extension intercepts HTTP requests, looks for `.m3u8` URLs
2. **Badge**: Shows the count of streams detected on the current tab
3. **Direct Play**: If m3u8 found, passes URL directly to mpv
4. **Fallback**: No m3u8 → yt-dlp extracts stream → mpv plays extracted URL

## Features

- **Universal Support**: Works on any site with video
- **m3u8 Detection**: Automatic stream detection for HLS streams
- **yt-dlp Fallback**: Extracts streams when m3u8 not available
- **Cookie Support**: Uses Chrome cookies for sites requiring login
- **Caching**: Persists detection across tab navigation
- **Refined Logic**: Version 2.0 features improved URL resolution and cleaner server handling

## Project Structure

```
MPVise/
├── background.js    # Extension logic (async/await, storage helpers)
├── daemon.py     # HTTP server + yt-dlp integration
├── launcher.py  # CLI for server management (improved daemon logic)
├── manifest.json # Chrome extension manifest (v2.0)
└── icons/      # Extension icons
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Server Offline | Run `python3 launcher.py` |
| Playback Failed | Site not supported or video unavailable |
| MPV not opening | Verify `mpv` is installed: `which mpv` |

## License

MIT