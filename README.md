# MPVise - Play on MPV

Chrome extension to detect m3u8 streams and YouTube videos, play directly on MPV.

## Supported Sites

- **YouTube** - plays any video
- **Any site** with m3u8 streams - auto-detects and plays

## Setup

1. Start the server:
   - **Linux/Mac**: `python3 launcher.py` or `python3 launcher.py --daemon`
   - **Windows**: Double-click `launcher.bat`

2. Load extension in Chrome:
   - Go to `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `MPVise` folder

## Usage

1. Open any video page (streaming site or YouTube)
2. Wait for video to start playing (triggers m3u8 detection)
3. Click extension icon:
   - **Badge shows count** = m3u8 URLs detected
   - **Click** → plays on MPV
   - **YouTube** → passes clean youtu.be URL

## Server Options

| Command | Mode | Use case |
|---------|------|----------|
| `python3 launcher.py` | Foreground | Ctrl+C to stop |
| `python3 launcher.py --daemon` | Background | Run & forget |
| `python3 launcher.py --kill` | Stop | Kill background server |

| OS | Start | Stop |
|----|-------|------|
| Linux/Mac | `python3 launcher.py` or `launcher.py --daemon` | `python3 launcher.py --kill` |
| Windows | Double-click `launcher.bat` | Restart |

## Files

```
MPVise/
├── launcher.py       # Main script (start/stop/daemon)
├── launcher.bat     # Windows shortcut
├── daemon.py        # Server backend
├── background.js    # Extension logic
├── manifest.json   # Chrome extension config
├── icons/          # Extension icons
└── README.md       # This file
```

## Troubleshooting

- **Server not running**: Run `python3 launcher.py`
- **No m3u8 found**: Make sure video is playing before clicking
- **MPV not opening**: Verify mpv is installed (`which mpv`)