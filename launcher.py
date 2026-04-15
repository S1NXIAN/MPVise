#!/usr/bin/env python3
"""
MPVise — launcher.py
Daemon lifecycle manager with a full argparse CLI.

Usage:
  python3 launcher.py start    # Start daemon in background
  python3 launcher.py stop     # Stop running daemon
  python3 launcher.py restart  # Restart daemon
  python3 launcher.py status   # Show status and last 5 log lines
  python3 launcher.py logs     # Print recent logs
  python3 launcher.py logs -f  # Follow log output (like tail -f)
  python3 launcher.py run      # Run in foreground (Ctrl+C to stop)
"""

import argparse
import asyncio
import os
import platform
import signal
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

IS_WINDOWS = platform.system() == "Windows"

CONFIG_DIR  = Path.home() / ".config" / "mpvise"
SOCKET_PATH = CONFIG_DIR / "mpvise.sock"
PID_FILE    = CONFIG_DIR / "daemon.pid"
LOG_PATH    = CONFIG_DIR / "daemon.log"

# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _ping(timeout: float = 2.0) -> bool:
    """Return True if the daemon is responsive on its Unix socket."""
    if not SOCKET_PATH.exists():
        return False
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(SOCKET_PATH)),
            timeout=timeout,
        )
        writer.write(b"GET /ping HTTP/1.0\r\nHost: localhost\r\n\r\n")
        await writer.drain()
        data = await asyncio.wait_for(reader.read(1024), timeout=timeout)
        writer.close()
        return b'"ok"' in data
    except Exception:
        return False


def _get_pid() -> int | None:
    try:
        if PID_FILE.exists():
            return int(PID_FILE.read_text().strip())
    except Exception:
        pass
    return None


def _pid_alive(pid: int) -> bool:
    """Cross-platform check that a PID corresponds to a running process."""
    if IS_WINDOWS:
        try:
            import ctypes
            STILL_ACTIVE = 259
            QUERY = 0x0400
            handle = ctypes.windll.kernel32.OpenProcess(QUERY, False, pid)
            if not handle:
                return False
            code = ctypes.c_ulong()
            ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(handle)
            return code.value == STILL_ACTIVE
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)  # Sends no signal; raises if PID is gone
            return True
        except (ProcessLookupError, PermissionError):
            return False


def _cleanup_stale() -> None:
    """Remove PID/socket files left by a crashed daemon."""
    pid = _get_pid()
    if pid and not _pid_alive(pid):
        print(f"[!] Removing stale daemon files (PID {pid} is dead).")
        PID_FILE.unlink(missing_ok=True)
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()

# ─── Commands ─────────────────────────────────────────────────────────────────

async def cmd_start(args: argparse.Namespace) -> None:
    """Start the daemon in background (detached subprocess)."""
    _cleanup_stale()

    if await _ping():
        pid = _get_pid()
        print(f"MPVise is already running{f' (PID {pid})' if pid else ''}.")
        return

    daemon_script = Path(__file__).parent / "daemon.py"
    if not daemon_script.exists():
        print(f"Error: daemon.py not found at {daemon_script}", file=sys.stderr)
        sys.exit(1)

    if IS_WINDOWS:
        DETACHED_PROCESS      = 0x00000008
        CREATE_NEW_PROC_GROUP = 0x00000200
        subprocess.Popen(
            [sys.executable, str(daemon_script)],
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROC_GROUP,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )
    else:
        # start_new_session=True creates a new session so the daemon survives
        # launcher exit and is reparented to init/systemd.
        subprocess.Popen(
            [sys.executable, str(daemon_script)],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )

    print("Starting MPVise…", end="", flush=True)

    for _ in range(50):           # Poll for up to 5 seconds
        await asyncio.sleep(0.1)
        if await _ping(timeout=1.0):
            pid = _get_pid()
            print(f" ready{f' (PID {pid})' if pid else ''}.")
            return

    print("\nDaemon did not respond within 5 s. Check logs:")
    print(f"  python3 launcher.py logs")


async def cmd_stop(args: argparse.Namespace) -> None:
    """Gracefully stop the daemon (SIGTERM → 3 s wait → SIGKILL)."""
    _cleanup_stale()
    pid = _get_pid()

    if not pid and not await _ping():
        print("MPVise is not running.")
        return

    if pid:
        print(f"Stopping MPVise (PID {pid})…", end="", flush=True)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

        for _ in range(30):           # Wait up to 3 seconds
            await asyncio.sleep(0.1)
            if not _pid_alive(pid):
                break
        else:
            # Daemon didn't exit cleanly — force kill
            try:
                os.kill(pid, signal.SIGKILL)
                await asyncio.sleep(0.2)
            except ProcessLookupError:
                pass

    # Clean up leftover files
    PID_FILE.unlink(missing_ok=True)
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    print(" stopped.")


async def cmd_restart(args: argparse.Namespace) -> None:
    await cmd_stop(args)
    await asyncio.sleep(0.3)
    await cmd_start(args)


async def cmd_status(args: argparse.Namespace) -> None:
    """Print running state, PID, and the last 5 log lines."""
    _cleanup_stale()
    running = await _ping()
    pid     = _get_pid()

    if running:
        pid_str = f" (PID {pid})" if pid else ""
        print(f"✓ MPVise is running{pid_str}.")
    else:
        print("✗ MPVise is not running.")
        return

    if LOG_PATH.exists():
        lines = LOG_PATH.read_text(errors="replace").splitlines()
        if lines:
            print("\nRecent log entries:")
            for line in lines[-5:]:
                print(f"  {line}")


async def cmd_logs(args: argparse.Namespace) -> None:
    """Print daemon logs; with -f/--follow, stream new lines."""
    if not LOG_PATH.exists():
        print("No log file found at", LOG_PATH)
        return

    if args.follow:
        try:
            # Prefer tail(1) on POSIX for efficiency
            subprocess.run(["tail", "-n", "50", "-f", str(LOG_PATH)])
        except (FileNotFoundError, KeyboardInterrupt):
            # Windows / systems without tail — simple polling fallback
            import time
            with LOG_PATH.open(errors="replace") as f:
                # Print last 50 lines first
                content = f.read().splitlines()
                for line in content[-50:]:
                    print(line)
                f.seek(0, 2)  # Seek to end
                while True:
                    line = f.readline()
                    if line:
                        print(line, end="", flush=True)
                    else:
                        time.sleep(0.15)
    else:
        lines = LOG_PATH.read_text(errors="replace").splitlines()
        print("\n".join(lines[-100:]))  # Print last 100 lines


async def cmd_run(args: argparse.Namespace) -> None:
    """Run daemon in foreground (useful for debugging)."""
    # Import daemon here to avoid circular-import issues if launcher is
    # imported as a module.
    import importlib.util
    daemon_path = Path(__file__).parent / "daemon.py"
    spec   = importlib.util.spec_from_file_location("daemon", daemon_path)
    daemon = importlib.util.module_from_spec(spec)   # type: ignore[arg-type]
    spec.loader.exec_module(daemon)                   # type: ignore[union-attr]
    try:
        await daemon.main()
    except KeyboardInterrupt:
        print("\nStopped.")

# ─── CLI ──────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="launcher.py",
        description="MPVise daemon lifecycle manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("start",   help="Start daemon in background")
    sub.add_parser("stop",    help="Stop the running daemon")
    sub.add_parser("restart", help="Restart the daemon")
    sub.add_parser("status",  help="Show running state and last 5 log lines")
    sub.add_parser("run",     help="Run daemon in foreground (Ctrl+C to stop)")

    logs_p = sub.add_parser("logs", help="Show daemon logs")
    logs_p.add_argument(
        "-f", "--follow",
        action="store_true",
        help="Follow log output (like tail -f)",
    )
    return parser


def main() -> None:
    parser = _build_parser()
    args   = parser.parse_args()

    handlers = {
        "start":   cmd_start,
        "stop":    cmd_stop,
        "restart": cmd_restart,
        "status":  cmd_status,
        "logs":    cmd_logs,
        "run":     cmd_run,
        None:      cmd_run,    # Default: foreground (preserves old behaviour)
    }

    fn = handlers.get(args.command, cmd_run)
    try:
        asyncio.run(fn(args))
    except KeyboardInterrupt:
        print("\nInterrupted.")


if __name__ == "__main__":
    main()
