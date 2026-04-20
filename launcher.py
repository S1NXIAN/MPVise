#!/usr/bin/env python3 -B
import os; os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
"""MPVise — daemon manager CLI.

Usage:
  python3 launcher.py start
  python3 launcher.py stop
  python3 launcher.py restart
  python3 launcher.py status
  python3 launcher.py logs [-f]
  python3 launcher.py          # foreground (same as 'run')
"""

import argparse
import asyncio
import os
import platform
import signal
import subprocess
import sys
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "mpvise"
PID_FILE   = CONFIG_DIR / "daemon.pid"
LOG_PATH   = CONFIG_DIR / "daemon.log"
PORT       = 8765
IS_WIN     = platform.system() == "Windows"

# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_pid() -> int | None:
    try:
        return int(PID_FILE.read_text().strip()) if PID_FILE.exists() else None
    except Exception:
        return None


def pid_alive(pid: int) -> bool:
    if IS_WIN:
        try:
            import ctypes
            h = ctypes.windll.kernel32.OpenProcess(0x0400, False, pid)
            if not h:
                return False
            code = ctypes.c_ulong()
            ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(h)
            return code.value == 259
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


async def is_alive(timeout: float = 2.0) -> bool:
    """Ping the daemon over TCP without any third-party deps."""
    try:
        r, w = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", PORT), timeout=timeout
        )
        w.write(b"GET /ping HTTP/1.0\r\nHost: localhost\r\n\r\n")
        await w.drain()
        data = await asyncio.wait_for(r.read(256), timeout=timeout)
        w.close()
        return b'"ok"' in data
    except Exception:
        return False


def daemon_script() -> Path:
    return Path(__file__).parent / "daemon.py"


def clean_stale() -> None:
    pid = get_pid()
    if pid and not pid_alive(pid):
        print(f"  Removing stale PID {pid}.")
        PID_FILE.unlink(missing_ok=True)

# ─── Commands ─────────────────────────────────────────────────────────────────

async def cmd_start(_args) -> None:
    clean_stale()
    if await is_alive():
        print(f"Already running (PID {get_pid()}).")
        return

    kw = dict(
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )
    if IS_WIN:
        subprocess.Popen(
            [sys.executable, str(daemon_script())],
            creationflags=0x00000008 | 0x00000200,  # DETACHED | NEW_GROUP
            **kw,
        )
    else:
        subprocess.Popen(
            [sys.executable, str(daemon_script())],
            start_new_session=True,
            close_fds=True,
            **kw,
        )

    print("Starting…", end="", flush=True)
    for _ in range(30):
        await asyncio.sleep(0.2)
        if await is_alive():
            print(f" ready (PID {get_pid()}).")
            return
    print("\nDaemon didn't respond. Check: python3 launcher.py logs")


async def cmd_stop(_args) -> None:
    clean_stale()
    pid = get_pid()
    if not pid:
        print("Not running.")
        return

    print(f"Stopping PID {pid}…", end="", flush=True)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

    for _ in range(30):
        await asyncio.sleep(0.1)
        if not pid_alive(pid):
            break
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    PID_FILE.unlink(missing_ok=True)
    print(" done.")


async def cmd_restart(args) -> None:
    await cmd_stop(args)
    await asyncio.sleep(0.3)
    await cmd_start(args)


async def cmd_status(_args) -> None:
    clean_stale()
    alive = await is_alive()
    pid   = get_pid()
    print(f"{'✓ Running' if alive else '✗ Stopped'}"
          f"{f'  (PID {pid})' if pid and alive else ''}")
    if alive and LOG_PATH.exists():
        lines = LOG_PATH.read_text(errors="replace").splitlines()
        if lines:
            print("\nRecent log:")
            for line in lines[-5:]:
                print(f"  {line}")


async def cmd_logs(args) -> None:
    if not LOG_PATH.exists():
        print("No log file found.")
        return
    if args.follow:
        try:
            subprocess.run(["tail", "-n50", "-f", str(LOG_PATH)])
        except (FileNotFoundError, KeyboardInterrupt):
            pass
    else:
        lines = LOG_PATH.read_text(errors="replace").splitlines()
        print("\n".join(lines[-100:]))


async def cmd_run(_args) -> None:
    """Run daemon in foreground (default when no subcommand given)."""
    import importlib.util
    spec   = importlib.util.spec_from_file_location("daemon", daemon_script())
    daemon = importlib.util.module_from_spec(spec)   # type: ignore
    spec.loader.exec_module(daemon)                   # type: ignore
    await daemon.main()

# ─── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(
        prog="launcher.py",
        description="MPVise daemon manager",
    )
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("start")
    sub.add_parser("stop")
    sub.add_parser("restart")
    sub.add_parser("status")
    sub.add_parser("run")
    lg = sub.add_parser("logs")
    lg.add_argument("-f", "--follow", action="store_true", help="Follow log output")

    args = p.parse_args()
    fn = {
        "start":   cmd_start,
        "stop":    cmd_stop,
        "restart": cmd_restart,
        "status":  cmd_status,
        "logs":    cmd_logs,
        "run":     cmd_run,
    }.get(args.cmd, cmd_run)

    try:
        asyncio.run(fn(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
