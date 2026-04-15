#!/usr/bin/env python3
import os
import sys
import json
import re
import subprocess
import socket
import asyncio
import aiohttp
from aiohttp import web
from pathlib import Path
from urllib.parse import urlparse, unquote

# Prevent bytecode generation
sys.dont_write_bytecode = True

# Config paths
CONFIG_DIR = Path.home() / ".config" / "mpvise"
SOCKET_PATH = CONFIG_DIR / "mpvise.sock"
LOG_PATH = CONFIG_DIR / "daemon.log"

# Ensure config dir exists
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

# Logging setup
import logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Constants
TIMEOUT = 30
BROWSERS = ['vivaldi', 'chrome', 'firefox', 'brave']
MPV_SOCKET = Path("/tmp/mpvsocket")

# Image detection patterns
IMAGE_RE = re.compile(r'\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)', re.I)

def is_video_url(url: str) -> bool:
    if not url or not url.startswith(('http://', 'https://')):
        return False
    if IMAGE_RE.search(url):
        return False
    if any(x in url.lower() for x in ['i.ytimg.com', 'thumbnail', 'poster.jpg']):
        return False
    return True

def sanitize_url(url: str) -> str:
    """Basic validation to prevent shell injection"""
    if len(url) > 8192:
        raise ValueError("URL too long")
    if re.search(r'[;|`${}<>]', url):
        raise ValueError("Invalid characters in URL")
    return url

async def extract_stream(url: str) -> str | None:
    """Fast yt-dlp extraction"""
    url = sanitize_url(url)
    
    # Try without cookies first (fastest)
    attempts = [None] + BROWSERS
    
    for browser in attempts:
        cmd = ['yt-dlp', '--no-warnings', '-q', '-g']
        
        if browser:
            cmd.extend(['--cookies-from-browser', browser])
        
        # Fast format selection
        cmd.extend([
            '-f', 'best[height<=1080]/best',
            '--no-playlist',  # Don't fetch playlists
            '--', url
        ])
        
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=TIMEOUT
            )
            
            if proc.returncode == 0:
                lines = [l.strip() for l in stdout.decode().split('\n') 
                        if l.strip() and l.startswith('http')]
                
                for line in lines:
                    if is_video_url(line):
                        logger.info(f"SUCCESS: Extracted URL via {browser or 'no-cookies'}")
                        return line
                        
            else:
                err = stderr.decode().strip()
                if "could not find" in err.lower() and "cookies" in err.lower():
                    logger.debug(f"INFO: Browser {browser} has no cookies for this site")
                    continue
                logger.error(f"YT-DLP ERROR ({browser or 'direct'}): {err[:500]}")
                
        except asyncio.TimeoutError:
            logger.warning(f"TIMEOUT: {browser or 'no-cookies'} took too long")
        except Exception as e:
            logger.error(f"EXTRACTION FAILED: {type(e).__name__}: {e}")
    
    return None

async def add_to_mpv_queue(url: str) -> bool:
    """Try to add to existing mpv instance"""
    if not MPV_SOCKET.exists():
        logger.debug("DEBUG: MPV socket not found, starting new instance")
        return False
    
    try:
        reader, writer = await asyncio.open_unix_connection(str(MPV_SOCKET))
        cmd = f'loadfile "{url}" append-play\n'
        writer.write(cmd.encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        logger.info(f"QUEUED: Added {url[:60]}... to existing mpv session")
        return True
    except Exception as e:
        logger.warning(f"QUEUE FAILED: Could not send to mpv socket: {e}")
        return False

async def launch_mpv(url: str):
    """Launch mpv with optimizations"""
    if not is_video_url(url):
        logger.error(f"INVALID: Not a video URL: {url[:100]}")
        return
    
    # Try to add to queue first
    if await add_to_mpv_queue(url):
        return
    
    # Launch new mpv instance
    cmd = [
        'mpv',
        '--force-window=immediate',
        '--keep-open=yes',
        '--cache=yes',
        '--cache-secs=30',
        '--demuxer-max-bytes=50M',
        '--input-ipc-server=/tmp/mpvsocket',
        '--ytdl-format=best[height<=1080]/best',
        '--hwdec=auto',
        '--', url
    ]
    
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True
        )
        logger.info(f"LAUNCHED: mpv (PID: {proc.pid}) for {url[:60]}...")
    except Exception as e:
        logger.error(f"MPV LAUNCH FAILED: {e}")

# HTTP Handlers
async def handle_ping(request):
    return web.Response(text='pong', headers={
        'Access-Control-Allow-Origin': '*',
    })

async def handle_play(request):
    # Handle preflight
    if request.method == 'OPTIONS':
        return web.Response(headers={
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        })
        
    try:
        data = await request.json()
        url = data.get('url', '').strip()
        use_fallback = data.get('fallback', True)
        
        if not url:
            logger.warning("REQUEST ERROR: No URL provided in payload")
            return web.json_response({"error": "No URL"}, status=400, headers={'Access-Control-Allow-Origin': '*'})
        
        logger.info(f"PLAY REQUEST: {url}")
        
        target_url = url
        
        if use_fallback:
            logger.info(f"EXTRACTING: {url[:60]}...")
            extracted = await extract_stream(url)
            if extracted:
                target_url = extracted
            else:
                logger.error(f"EXTRACTION FAILED: {url}")
                return web.json_response(
                    {"error": "Extraction failed"}, 
                    status=500,
                    headers={'Access-Control-Allow-Origin': '*'}
                )
        
        if not is_video_url(target_url):
            logger.error(f"INVALID URL: {target_url[:100]}")
            return web.json_response(
                {"error": "Not a valid video URL"}, 
                status=400,
                headers={'Access-Control-Allow-Origin': '*'}
            )
        
        # Launch async (don't wait)
        asyncio.create_task(launch_mpv(target_url))
        
        return web.json_response(
            {"ok": True, "message": "Playing"},
            headers={'Access-Control-Allow-Origin': '*'}
        )
        
    except Exception as e:
        logger.error(f"Handler error: {e}")
        return web.json_response(
            {"error": str(e)}, 
            status=500,
            headers={'Access-Control-Allow-Origin': '*'}
        )

async def init_app():
    app = web.Application()
    app.router.add_get('/ping', handle_ping)
    app.router.add_post('/play', handle_play)
    app.router.add_options('/play', handle_play)
    return app

async def main():
    # Cleanup old socket
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    
    app = await init_app()
    runner = web.AppRunner(app)
    await runner.setup()
    
    # Listen on Unix socket
    unix_site = web.UnixSite(runner, str(SOCKET_PATH))
    await unix_site.start()
    
    # Listen on TCP (for the browser extension)
    tcp_site = web.TCPSite(runner, '127.0.0.1', 8765, reuse_address=True, reuse_port=True)
    await tcp_site.start()
    
    # Set permissions so browser can connect
    os.chmod(SOCKET_PATH, 0o666)
    
    logger.info(f"MPVise listening on {SOCKET_PATH} and 127.0.0.1:8765")
    
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        await runner.cleanup()
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Shutting down")
