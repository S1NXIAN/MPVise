#!/usr/bin/env python3
import os
import sys
import signal
import asyncio
import socket
from pathlib import Path

# Prevent bytecode generation
sys.dont_write_bytecode = True

CONFIG_DIR = Path.home() / ".config" / "mpvise"
SOCKET_PATH = CONFIG_DIR / "mpvise.sock"
PID_FILE = CONFIG_DIR / "daemon.pid"
LOG_PATH = CONFIG_DIR / "daemon.log"

async def is_running():
    """Check if daemon is responsive"""
    if not SOCKET_PATH.exists():
        return False
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(SOCKET_PATH)),
            timeout=1.0
        )
        writer.write(b"GET /ping HTTP/1.0\r\n\r\n")
        await writer.drain()
        data = await asyncio.wait_for(reader.read(1024), timeout=1.0)
        writer.close()
        return b"pong" in data
    except:
        return False

def get_pid():
    try:
        if PID_FILE.exists():
            return int(PID_FILE.read_text().strip())
    except:
        pass
    return None

def save_pid(pid):
    PID_FILE.write_text(str(pid))

def remove_pid():
    PID_FILE.unlink(missing_ok=True)

async def start_daemon():
    """Start daemon in background"""
    if await is_running():
        print("MPVise already running")
        return
    
    # Fork to background
    pid = os.fork()
    if pid > 0:
        # Parent - wait for daemon to be ready
        save_pid(pid)
        for _ in range(50):  # 5 seconds
            await asyncio.sleep(0.1)
            if await is_running():
                print(f"MPVise started (PID: {pid})")
                return
        print("Daemon failed to start, check logs")
        return
    
    # Child - start daemon
    os.setsid()
    os.umask(0)
    
    # Redirect output
    sys.stdout.flush()
    sys.stderr.flush()
    
    # Import and run daemon
    import daemon
    asyncio.run(daemon.main())

async def stop_daemon():
    """Stop the daemon"""
    pid = get_pid()
    
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):
                await asyncio.sleep(0.1)
                if not await is_running():
                    break
        except ProcessLookupError:
            pass
    
    # Cleanup
    remove_pid()
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    print("Stopped")

async def status():
    if await is_running():
        pid = get_pid()
        print(f"Running (PID: {pid})" if pid else "Running")
    else:
        print("Not running")

async def show_logs(follow=False):
    """Show daemon logs"""
    if not LOG_PATH.exists():
        print("No log file found")
        return
    
    if follow:
        import subprocess
        try:
            subprocess.run(['tail', '-f', str(LOG_PATH)])
        except KeyboardInterrupt:
            pass
    else:
        print(LOG_PATH.read_text())

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    
    if cmd in ("start", "daemon"):
        asyncio.run(start_daemon())
    elif cmd in ("stop", "kill"):
        asyncio.run(stop_daemon())
    elif cmd == "status":
        asyncio.run(status())
    elif cmd == "logs":
        asyncio.run(show_logs(follow=True))
    elif cmd == "run":
        # Run in foreground
        import daemon
        try:
            asyncio.run(daemon.main())
        except KeyboardInterrupt:
            print("\nStopped")
    else:
        print(f"Usage: {sys.argv[0]} {{start|stop|status|run}}")

if __name__ == '__main__':
    main()
