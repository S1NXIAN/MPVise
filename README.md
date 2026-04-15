# <img src="icons/play-button-48.png" align="center" width="32"> MPVise

> Play any web video directly in **mpv** with automatic stream detection and `yt-dlp` fallback.

MPVise is a lightweight browser extension and local daemon that bridges your web browser with the powerful [mpv media player](https://mpv.io/). It automatically sniffs for high-quality HLS master playlists (m3u8) while providing a robust fallback mechanism using `yt-dlp` for sites without direct stream exposure.

## ✨ Key Features

- **🎯 Smart Detection**: Intercepts HLS master playlists and filters out individual media segments to keep your badge clean.
- **⚡ One-Click Playback**: Click the extension icon to instantly send the detected stream to mpv.
- **🔗 Context Awareness**: Right-click any page, link, or video element to "Play with MPVise".
- **🍪 Cookie Sync**: Automatically uses your Chrome cookies for `yt-dlp` extraction, enabling playback from sites that require authentication.
- **🚀 Lightweight Daemon**: A minimal Python backend that stays out of your way and handles stream resolution.

## 📋 Requirements

Before you begin, ensure you have the following installed:

- **Python 3.x**
- **[mpv](https://mpv.io/)**: The media player.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)**: For advanced stream extraction.

## 🚀 Quick Start

### 1. Set up the Backend
Clone the repository and start the local server:

```bash
# Start in the foreground
python3 launcher.py

# OR start in the background (daemon mode)
python3 launcher.py --daemon
```

### 2. Install the Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked** and select the MPVise project directory.

## 🛠️ Usage

### Browser Extension
- **Badge Count**: The extension icon displays a badge showing how many valid HLS streams were detected on the current page.
- **Action Button**: Click the icon to play the first detected stream. If no streams are found, it will attempt to resolve the current page URL using `yt-dlp`.
- **Context Menu**: Right-click a link or video and select **Play with MPVise**.

### CLI Management
The `launcher.py` script provides simple management for the background process:

```bash
python3 launcher.py          # Start in foreground (Ctrl+C to stop)
python3 launcher.py --daemon # Start in background
python3 launcher.py --kill   # Stop the running server
```

> [!TIP]
> If playback fails, ensure the server is running by clicking the extension icon; it will notify you if it cannot reach `localhost:8765`.

## 🏗️ How it Works

1. **Sniffing**: The extension monitors network requests for `.m3u8` files and validates them as master playlists.
2. **Communication**: When triggered, the extension sends the URL to the local Python daemon via a POST request.
3. **Resolution**: The daemon either passes the URL directly to `mpv` or uses `yt-dlp` (with your browser's cookies) to find the best available stream.
4. **Playback**: `mpv` is launched as a detached process, allowing you to continue browsing while you watch.

## 🗺️ Roadmap

Active development is focused on expanding MPVise's reach and improving the "set-and-forget" experience. Upcoming features include:

- **💻 Multi-Platform Support**: Native Windows and macOS compatibility for the daemon and launcher scripts.
- **⚙️ System-Level Integration**: 
  - **Linux**: Systemd unit files for automatic background startup on login.
  - **macOS**: Launchd agents for seamless integration with the Mac ecosystem.
  - **Windows**: Background service installation and Scheduled Task automation.
- **🛠️ Zero-Config Setup**: Automated installers that handle `yt-dlp` and `mpv` environment configuration.

---

*MPVise v2.0*
