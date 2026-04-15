#!/usr/bin/env python3
"""
MPVise — daemon.py
Production-grade HTTP server bridging the browser extension to mpv.

Features:
  - Parallel yt-dlp extraction across browsers (asyncio.as_completed)
  - In-memory LRU-style URL cache with configurable TTL
  - Early bailout for direct media URLs (skip yt-dlp)
  - MPV JSON-IPC socket health check before queue/launch
  - Structured JSON error codes for the extension
  - Rotating log file (5 MB max, 2 backups)
  - Simple token-bucket rate limiter (10 req/s per IP)
  - /ping and /status endpoints
  - Configurable via ~/.config/mpvise/config.json or env vars
"""

import asyncio
import json
import logging
import os
import re
import sys
import time
from collections import defaultdict
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import aiohttp
from aiohttp import web

sys.dont_write_bytecode = True

# ─── Config Loading ────────────────────────────────────────────────────────────

CONFIG_DIR  = Path.home() / ".config" / "mpvise"
CONFIG_FILE = CONFIG_DIR / "config.json"
LOG_PATH    = CONFIG_DIR / "daemon.log"
PID_FILE    = CONFIG_DIR / "daemon.pid"
SOCKET_PATH = CONFIG_DIR / "mpvise.sock"

CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def _load_config() -> dict:
    """Merge defaults → config.json → environment variables."""
    defaults: dict = {
        "port":              8765,
        "mpv_socket":        "/tmp/mpvsocket",
        "mpv_args":          [],
        "ytdlp_format":      "best[height<=1080]/best",
        "browsers":          ["vivaldi", "chrome", "firefox", "brave"],
        "cache_ttl_seconds": 300,
        "log_max_bytes":     5 * 1024 * 1024,
        "ytdlp_timeout":     30,
        "rate_limit_rps":    10,
    }
    if CONFIG_FILE.exists():
        try:
            defaults.update(json.loads(CONFIG_FILE.read_text()))
        except Exception:
            pass  # Malformed config — fall back to defaults

    # Environment variable overrides
    if val := os.environ.get("MPVISE_SOCKET"):
        defaults["mpv_socket"] = val
    if val := os.environ.get("MPVISE_PORT"):
        defaults["port"] = int(val)

    return defaults


CONFIG        = _load_config()
PORT          = CONFIG["port"]
MPV_SOCKET    = Path(CONFIG["mpv_socket"])
BROWSERS      = CONFIG["browsers"]
YTDLP_FORMAT  = CONFIG["ytdlp_format"]
CACHE_TTL     = CONFIG["cache_ttl_seconds"]
YTDLP_TIMEOUT = CONFIG["ytdlp_timeout"]
EXTRA_MPV_ARGS: list[str] = CONFIG["mpv_args"]
RATE_LIMIT_RPS = CONFIG["rate_limit_rps"]

# ─── Logging ──────────────────────────────────────────────────────────────────

_fmt = logging.Formatter(
    "[%(asctime)s] %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

logger = logging.getLogger("mpvise")
logger.setLevel(logging.DEBUG)

_fh = RotatingFileHandler(
    LOG_PATH,
    maxBytes=CONFIG["log_max_bytes"],
    backupCount=2,
    encoding="utf-8",
)
_fh.setLevel(logging.DEBUG)
_fh.setFormatter(_fmt)

_sh = logging.StreamHandler(sys.stdout)
_sh.setLevel(logging.INFO)
_sh.setFormatter(_fmt)

logger.addHandler(_fh)
logger.addHandler(_sh)

# ─── Runtime State ────────────────────────────────────────────────────────────

_start_time: float    = time.time()
_last_error: str | None = None
_has_mpv:   bool      = False
_has_ytdlp: bool      = False


def _check_deps() -> None:
    """Verify mpv and yt-dlp are installed; set global flags."""
    global _has_mpv, _has_ytdlp
    import shutil
    _has_mpv   = shutil.which("mpv")    is not None
    _has_ytdlp = shutil.which("yt-dlp") is not None
    if not _has_mpv:
        logger.warning("mpv not found — install it: https://mpv.io")
    if not _has_ytdlp:
        logger.warning("yt-dlp not found — install it: https://github.com/yt-dlp/yt-dlp")

# ─── URL Validation ───────────────────────────────────────────────────────────

_IMAGE_RE       = re.compile(r'\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|ico)(\?|$)', re.I)
_DIRECT_MEDIA_RE = re.compile(r'\.(m3u8|mp4|webm|mkv|ts|mov|avi|flv)(\?|#|$)', re.I)


def is_valid_url(url: str) -> bool:
    """Return True if the URL looks like a playable media resource."""
    if not url or not url.startswith(("http://", "https://")):
        return False
    if len(url) > 8192:
        return False
    if _IMAGE_RE.search(url):
        return False
    if any(x in url.lower() for x in ("i.ytimg.com", "thumbnail", "poster")):
        return False
    return True


def is_direct_media(url: str) -> bool:
    """Return True if the URL path ends with a known playable extension.
    These URLs can be passed directly to mpv, skipping yt-dlp.
    """
    return bool(_DIRECT_MEDIA_RE.search(urlparse(url).path))


def sanitize_url(url: str) -> str:
    """Raise ValueError on obviously malicious inputs."""
    if len(url) > 8192:
        raise ValueError("URL exceeds maximum length (8192 chars)")
    # Block shell metacharacters (defense-in-depth; subprocess list args already safe)
    if re.search(r"[;|`${}<>]", url):
        raise ValueError("URL contains invalid characters")
    return url

# ─── Extracted URL Cache ──────────────────────────────────────────────────────

# page_url → (stream_url, browser_name, unix_timestamp)
_url_cache: dict[str, tuple[str, str | None, float]] = {}
_cache_lock = asyncio.Lock()


async def _cache_get(url: str) -> tuple[str, str | None] | None:
    async with _cache_lock:
        entry = _url_cache.get(url)
        if entry:
            stream_url, browser, ts = entry
            if time.time() - ts < CACHE_TTL:
                logger.debug("Cache hit for %s", url[:60])
                return stream_url, browser
            del _url_cache[url]
    return None


async def _cache_set(url: str, stream_url: str, browser: str | None) -> None:
    async with _cache_lock:
        _url_cache[url] = (stream_url, browser, time.time())


async def _cache_stats() -> dict:
    async with _cache_lock:
        valid = sum(1 for _, _, ts in _url_cache.values() if time.time() - ts < CACHE_TTL)
        return {"total": len(_url_cache), "valid": valid, "ttl_seconds": CACHE_TTL}

# ─── Stream Extraction ────────────────────────────────────────────────────────

async def _try_extract(url: str, browser: str | None) -> tuple[str | None, str | None]:
    """
    Run a single yt-dlp extraction attempt.
    Returns (stream_url, browser) on success, (None, None) on failure.
    Never raises (exceptions are logged and swallowed).
    """
    cmd = [
        "yt-dlp", "--no-warnings", "-q", "-g",
        "-f", YTDLP_FORMAT,
        "--no-playlist",
    ]
    if browser:
        cmd += ["--cookies-from-browser", browser]
    cmd += ["--", url]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=YTDLP_TIMEOUT)

        if proc.returncode == 0:
            lines = [
                ln.strip() for ln in stdout.decode(errors="replace").splitlines()
                if ln.strip().startswith("http")
            ]
            for line in lines:
                if is_valid_url(line) and not _IMAGE_RE.search(line):
                    return line, browser
        else:
            err = stderr.decode(errors="replace").strip()
            if "cookies" in err.lower():
                logger.debug("No cookies for browser %s", browser)
            else:
                logger.warning("yt-dlp (%s): %s", browser or "no-cookies", err[:200])

    except asyncio.TimeoutError:
        logger.warning("yt-dlp timeout (browser=%s)", browser or "no-cookies")
    except FileNotFoundError:
        # yt-dlp not installed — logged at startup; don't spam
        pass
    except Exception as exc:
        logger.error("yt-dlp exception (browser=%s): %s", browser, exc)

    return None, None


async def extract_stream(url: str) -> tuple[str | None, str | None]:
    """
    Parallel extraction across all configured browsers and no-cookies mode.
    Returns (stream_url, browser) as soon as the first successful result arrives;
    cancels remaining tasks to avoid wasted work.

    Results are cached for CACHE_TTL seconds to avoid repeat yt-dlp calls
    for the same page URL.
    """
    if not _has_ytdlp:
        raise FileNotFoundError("yt-dlp is not installed")

    # Cache check
    if cached := await _cache_get(url):
        return cached

    attempts = [None] + BROWSERS  # None = try without cookies first (fastest)
    tasks = [asyncio.create_task(_try_extract(url, b)) for b in attempts]

    stream_url:   str | None = None
    used_browser: str | None = None

    try:
        # Yield each task as it completes; stop on first success.
        for coro in asyncio.as_completed(tasks):
            try:
                result_url, result_browser = await coro
            except Exception:
                continue
            if result_url:
                stream_url   = result_url
                used_browser = result_browser
                break
    finally:
        # Cancel any still-running tasks (e.g., slow browser cookie reads)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    if stream_url:
        await _cache_set(url, stream_url, used_browser)
        logger.info("Extracted via %s: %.60s", used_browser or "no-cookies", stream_url)

    return stream_url, used_browser

# ─── MPV Control ─────────────────────────────────────────────────────────────

async def _mpv_socket_alive() -> bool:
    """
    Return True only if the MPV Unix socket exists AND responds to a
    JSON-IPC get_property command. Mere file existence is not sufficient
    (stale socket from a crashed mpv).
    """
    if not MPV_SOCKET.exists():
        return False
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(MPV_SOCKET)), timeout=1.0
        )
        probe = json.dumps({"command": ["get_property", "pause"]}) + "\n"
        writer.write(probe.encode())
        await asyncio.wait_for(writer.drain(), timeout=1.0)
        data = await asyncio.wait_for(reader.read(256), timeout=1.0)
        writer.close()
        # A healthy mpv returns either {"data": ...} or {"error": "success"}
        return b'"error":"success"' in data or b'"data":' in data
    except Exception:
        return False


async def _add_to_mpv_queue(url: str) -> bool:
    """Append URL to the running mpv playlist using JSON IPC."""
    if not await _mpv_socket_alive():
        logger.debug("mpv socket not alive — launching new instance")
        return False
    try:
        reader, writer = await asyncio.open_unix_connection(str(MPV_SOCKET))
        cmd = json.dumps({"command": ["loadfile", url, "append-play"]}) + "\n"
        writer.write(cmd.encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        logger.info("Queued in mpv: %.60s", url)
        return True
    except Exception as exc:
        logger.warning("mpv queue failed: %s", exc)
        return False


async def launch_mpv(
    url: str,
    referer: str | None = None,
    browser: str | None = None,
) -> None:
    """
    Launch mpv as a detached process (start_new_session=True) so it survives
    the daemon's own lifecycle. Tries to append to an existing instance first.
    All exceptions are caught and logged — never propagated to the HTTP handler.
    """
    try:
        if await _add_to_mpv_queue(url):
            return

        cmd = [
            "mpv",
            f"--input-ipc-server={MPV_SOCKET}",
            "--keep-open=yes",
            "--force-window=immediate",
            "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ]
        if referer:
            cmd.append(f"--referrer={referer}")
        if browser:
            cmd.append(f"--cookies-from-browser={browser}")
        if EXTRA_MPV_ARGS:
            cmd.extend(EXTRA_MPV_ARGS)
        cmd += ["--", url]

        mpv_log = open(CONFIG_DIR / "mpv.log", "a")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=mpv_log,
            stdin=asyncio.subprocess.DEVNULL,
            start_new_session=True,  # Detach from daemon's process group
        )
        logger.info("Launched mpv PID=%d: %.60s", proc.pid, url)

    except FileNotFoundError:
        logger.error("mpv executable not found — install mpv")
    except Exception as exc:
        logger.error("mpv launch failed: %s", exc)

# ─── Rate Limiter ─────────────────────────────────────────────────────────────

# Token-bucket per IP: sliding window counting requests in the last 1 second.
_rate_buckets: dict[str, list[float]] = defaultdict(list)


def _is_rate_limited(ip: str) -> bool:
    now    = time.monotonic()
    bucket = _rate_buckets[ip]
    # Evict timestamps older than 1 second
    _rate_buckets[ip] = [t for t in bucket if now - t < 1.0]
    if len(_rate_buckets[ip]) >= RATE_LIMIT_RPS:
        return True
    _rate_buckets[ip].append(now)
    return False

# ─── HTTP Helpers ─────────────────────────────────────────────────────────────

_CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _json(data: dict, status: int = 200) -> web.Response:
    """Return a JSON response with CORS headers pre-applied."""
    return web.Response(
        text=json.dumps(data),
        content_type="application/json",
        status=status,
        headers=_CORS,
    )

# ─── HTTP Handlers ────────────────────────────────────────────────────────────

async def handle_ping(request: web.Request) -> web.Response:
    """Health-check endpoint. Returns uptime so the extension can confirm
    the daemon is alive as quickly as possible."""
    return _json({"ok": True, "uptime_seconds": round(time.time() - _start_time)})


async def handle_status(request: web.Request) -> web.Response:
    """Rich status endpoint — useful for diagnostics."""
    stats = await _cache_stats()
    return _json({
        "ok":             True,
        "uptime_seconds": round(time.time() - _start_time),
        "cache":          stats,
        "last_error":     _last_error,
        "deps":           {"mpv": _has_mpv, "yt_dlp": _has_ytdlp},
        "config": {
            "port":       PORT,
            "mpv_socket": str(MPV_SOCKET),
            "ytdlp_format": YTDLP_FORMAT,
        },
    })


async def handle_options(request: web.Request) -> web.Response:
    """Handle CORS preflight requests."""
    return web.Response(status=204, headers=_CORS)


async def handle_play(request: web.Request) -> web.Response:
    """
    Main playback endpoint.

    Request body (JSON):
      url      str   — target URL (page or direct media)
      fallback bool  — if true, pass through yt-dlp extraction first
      referer  str?  — optional referer for mpv

    Response (JSON):
      {"ok": true, "message": "Playing"}
      {"error": "<human message>", "code": "<ERROR_CODE>"}

    Error codes:
      RATE_LIMITED        — too many requests from this IP
      BAD_REQUEST         — malformed JSON body
      INVALID_URL         — URL failed validation
      MISSING_DEPENDENCY  — mpv or yt-dlp not installed
      EXTRACTION_FAILED   — yt-dlp could not find a stream
      MPV_LAUNCH_FAILED   — (rare) process could not be spawned
    """
    global _last_error

    # ── Rate limit ─────────────────────────────────────────────────────────────
    ip = request.remote or "127.0.0.1"
    if _is_rate_limited(ip):
        return _json({"error": "Rate limit exceeded", "code": "RATE_LIMITED"}, 429)

    # ── Parse body ─────────────────────────────────────────────────────────────
    try:
        data = await request.json()
    except Exception:
        return _json({"error": "Invalid JSON body", "code": "BAD_REQUEST"}, 400)

    url          = data.get("url", "").strip()
    use_fallback = bool(data.get("fallback", True))
    referer      = data.get("referer") or url

    if not url:
        return _json({"error": "No URL provided", "code": "INVALID_URL"}, 400)

    try:
        url = sanitize_url(url)
    except ValueError as exc:
        return _json({"error": str(exc), "code": "INVALID_URL"}, 400)

    if not is_valid_url(url):
        return _json({"error": "Not a valid video URL", "code": "INVALID_URL"}, 400)

    logger.info("PLAY [%s]: %.80s", "ytdlp" if use_fallback else "direct", url)

    target_url    = url
    target_browser: str | None = None

    # ── yt-dlp extraction (if needed) ─────────────────────────────────────────
    if use_fallback and not is_direct_media(url):
        if not _has_ytdlp:
            _last_error = "yt-dlp not installed"
            return _json({"error": "yt-dlp is not installed", "code": "MISSING_DEPENDENCY"}, 503)

        try:
            extracted, browser = await extract_stream(url)
        except FileNotFoundError:
            _last_error = "yt-dlp not installed"
            return _json({"error": "yt-dlp is not installed", "code": "MISSING_DEPENDENCY"}, 503)

        if not extracted:
            _last_error = f"Extraction failed: {url}"
            logger.error("Extraction failed for: %.80s", url)
            return _json(
                {"error": "Could not extract a stream URL", "code": "EXTRACTION_FAILED"}, 500
            )

        target_url    = extracted
        target_browser = browser

    # ── Dependency check ───────────────────────────────────────────────────────
    if not _has_mpv:
        _last_error = "mpv not installed"
        return _json({"error": "mpv is not installed", "code": "MISSING_DEPENDENCY"}, 503)

    # ── Dispatch mpv (non-blocking) ────────────────────────────────────────────
    asyncio.create_task(
        launch_mpv(target_url, referer=referer, browser=target_browser)
    )

    return _json({"ok": True, "message": "Playing"})

# ─── App Setup ────────────────────────────────────────────────────────────────

async def _create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/ping",          handle_ping)
    app.router.add_get("/status",        handle_status)
    app.router.add_post("/play",         handle_play)
    app.router.add_options("/play",      handle_options)
    return app


async def main() -> None:
    _check_deps()

    # Write PID for launcher.py
    PID_FILE.write_text(str(os.getpid()))

    # Clean up stale socket
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()

    app    = await _create_app()
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()

    # Unix socket (used by launcher's ping check)
    unix_site = web.UnixSite(runner, str(SOCKET_PATH))
    await unix_site.start()
    os.chmod(SOCKET_PATH, 0o666)

    # TCP socket (used by the browser extension)
    tcp_site = web.TCPSite(runner, "127.0.0.1", PORT, reuse_address=True, reuse_port=True)
    await tcp_site.start()

    logger.info("MPVise listening on 127.0.0.1:%d and %s", PORT, SOCKET_PATH)

    # Graceful shutdown on SIGTERM / SIGINT
    loop = asyncio.get_running_loop()
    stop: asyncio.Future = loop.create_future()

    def _shutdown(sig: int) -> None:
        if not stop.done():
            stop.set_result(sig)

    import signal
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _shutdown, sig)
        except NotImplementedError:
            pass  # Windows

    try:
        await stop
    finally:
        logger.info("Shutting down…")
        await runner.cleanup()
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()
        PID_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
