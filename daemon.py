#!/usr/bin/env python3 -B
import os; os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
"""MPVise daemon — minimal, fast."""

import asyncio
import logging
import os
import signal
from pathlib import Path

from aiohttp import web

# ─── Config ───────────────────────────────────────────────────────────────────

PORT       = int(os.environ.get("MPVISE_PORT", 8765))
CONFIG_DIR = Path.home() / ".config" / "mpvise"
LOG_PATH   = CONFIG_DIR / "daemon.log"
PID_FILE   = CONFIG_DIR / "daemon.pid"
BROWSERS   = ["vivaldi", "chrome", "chromium", "firefox", "brave"]
FORMAT     = "best[height<=1080]/best"

CONFIG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
    ],
)
log = logging.getLogger("mpvise")

# ─── URL helpers ──────────────────────────────────────────────────────────────

_DIRECT_EXTS = (".m3u8", ".mp4", ".webm", ".mkv", ".ts", ".mov", ".avi", ".flv")

def is_direct_media(url: str) -> bool:
    """True → pass straight to mpv without yt-dlp."""
    from urllib.parse import urlparse
    path = urlparse(url).path.lower()
    return any(path.endswith(e) or (e + "?") in path for e in _DIRECT_EXTS)

# ─── yt-dlp extraction ────────────────────────────────────────────────────────

async def _try(url: str, browser: str | None) -> str | None:
    """Single yt-dlp attempt. Returns the stream URL or None."""
    cmd = ["yt-dlp", "-q", "--no-warnings", "-g",
           "-f", FORMAT, "--no-playlist"]
    if browser:
        cmd += ["--cookies-from-browser", browser]
    cmd += ["--", url]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode == 0:
            for line in out.decode(errors="replace").splitlines():
                line = line.strip()
                if line.startswith("http"):
                    return line
    except Exception:
        pass
    return None


async def extract(url: str) -> str | None:
    """Run all browsers + no-cookies in parallel; return first winner."""
    tasks = [asyncio.create_task(_try(url, b)) for b in [None, *BROWSERS]]
    result = None
    try:
        for done in asyncio.as_completed(tasks):
            r = await done
            if r:
                result = r
                break
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return result

# ─── Handlers ─────────────────────────────────────────────────────────────────

async def handle_ping(req: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def handle_play(req: web.Request) -> web.Response:
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"error": "bad request"}, status=400)

    url     = (data.get("url") or "").strip()
    referer = (data.get("referer") or url).strip()
    direct  = bool(data.get("direct", False))  # True = pre-validated stream, skip yt-dlp

    if not url.startswith("http"):
        return web.json_response({"error": "invalid url"}, status=400)

    log.info("PLAY%s: %s", " [direct]" if direct else "", url[:100])

    # Resolve playable URL
    target = url
    if not direct and not is_direct_media(url):
        target = await extract(url)
        if not target:
            log.error("Extraction failed: %s", url[:100])
            return web.json_response(
                {"error": "Could not extract a stream URL"}, status=500
            )
        log.info("→ %s", target[:80])

    # Launch mpv (detached — survives daemon restart)
    try:
        await asyncio.create_subprocess_exec(
            "mpv",
            f"--referrer={referer}",
            "--",
            target,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
    except FileNotFoundError:
        return web.json_response({"error": "mpv not found"}, status=503)

    return web.json_response({"ok": True, "message": "Playing"})

# ─── App ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    PID_FILE.write_text(str(os.getpid()))

    app = web.Application()
    app.router.add_get("/ping", handle_ping)
    app.router.add_post("/play", handle_play)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT, reuse_address=True).start()
    log.info("MPVise on 127.0.0.1:%d  (PID %d)", PORT, os.getpid())

    loop = asyncio.get_running_loop()
    stop: asyncio.Future = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set_result, sig)
        except NotImplementedError:
            pass  # Windows

    try:
        await stop
    finally:
        await runner.cleanup()
        PID_FILE.unlink(missing_ok=True)
        log.info("Stopped.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
