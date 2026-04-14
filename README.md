# 🗺️ MPVise Development Roadmap

> **Current Version:** 1.0  
> **Focus:** Linux first, then macOS, then Windows.  
> **Philosophy:** No bloat, just float. Keep it simple, transparent, and hackable.

---

## 🚀 Upcoming Release (v1.1)

| Task | Description | Status |
|------|-------------|--------|
| **Fix M3U8 Detection Staleness** | After navigating between episodes on SPAs, cached M3U8 URLs cause wrong playback. Clear cache on navigation and re-detect on popup open. | ⬜ Pending |
| **Systemd Setup Script** | Auto‑install user service with directory detection, restart on failure, and idempotent behavior. | ⬜ Pending |
| **Systemd Uninstall Script** | Cleanly stop, disable, and remove the user service. | ⬜ Pending |

---

## 🐧 v1.2 – Linux Foundation

- [ ] **Universal Fallback** – Pass unsupported page URLs directly to MPV, letting the user's `yt-dlp` handle extraction.
- [ ] **Clean YouTube URL Extraction** – Verify YouTube links are shortened to `youtu.be/ID` for optimal handoff.
- [ ] **Robust Error Handling** – Log errors to `~/.cache/mpvise/mpvise.log` and surface MPV‑not‑found errors in the extension UI.

---

## 🌐 v1.3 – Browser Integration

- [ ] **Context Menu (Right‑Click)** – Add "Play with MPVise" to Chrome's context menu for pages, links, and video elements.
- [ ] **Keyboard Shortcut** – Define `Ctrl+Shift+M` (configurable) to play the current tab.
- [ ] **Badge Indicator Polish** – Keep the M3U8 count badge; optionally change color when server is unreachable.

---

## 💻 v1.4 – Cross‑Platform Support

| Platform | Task |
|----------|------|
| **macOS** | Create `setup-launchd.sh` to generate and load a LaunchAgent plist. |
| **Windows** | Create `setup-task.ps1` to register a hidden scheduled task with a 30‑second delay. |
| **Universal** | Add a top‑level `install.sh` / `install.ps1` that detects the OS and delegates to the correct setup script. |

---

## 📚 v1.5 – Documentation & Polish

- [ ] **Update `README.md`** – Document the three usage tiers (foreground, `--daemon`, systemd), troubleshooting, and new features.
- [ ] **Add Uninstall Instructions** – Clear steps for each platform to remove the service/task and delete the folder.
- [ ] **Add `CONTRIBUTING.md`** (optional) – Guidelines for potential contributors.

---

## ✨ Future Ideas (v2.0+)

- [ ] **yt‑dlp Fallback Toggle** – Simple options page or config flag to disable fallback behavior.
- [ ] **Linux Packaging** – AUR package, `.deb`, and Flatpak manifest.
- [ ] **Error Notification in Popup** – Show a friendly message when the local server is down.
- [ ] **Auto‑Update Check** – Optional periodic check for new releases.

---

*Last updated: April 2026*
