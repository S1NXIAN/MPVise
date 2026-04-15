#!/usr/bin/env python3
import os
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import subprocess, sys, time, socket, signal

PORT = 8765
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def isServerRunning():
  try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    s.connect(('localhost', PORT))
    s.close()
    return True
  except:
    return False

def startDaemon():
  proc = subprocess.Popen(
    [sys.executable, os.path.join(SCRIPT_DIR, 'daemon.py')],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True
  )
  time.sleep(1)
  return proc

def start(daemon=False):
  if isServerRunning():
    print(f'MPVise server already running on http://localhost:{PORT}')
    return

  print('Starting MPVise...')
  proc = startDaemon()

  if not isServerRunning():
    print('Failed to start')
    return

  if daemon:
    print(f'Running in background (PID: {proc.pid})')
    print('Stays active until restart or: python3 launcher.py --kill')
    sys.exit(0)

  print(f'MPVise started on http://localhost:{PORT}')
  print('Press Ctrl+C to stop')
  try:
    while True:
      time.sleep(1)
  except KeyboardInterrupt:
    print('\nStopping...')
    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)

def stop():
  if not isServerRunning():
    print('Server not running')
    return
  print('Stopping MPVise...')
  subprocess.run(['pkill', '-f', 'daemon.py'], capture_output=True)
  print('Stopped')

if __name__ == '__main__':
  arg = sys.argv[1] if len(sys.argv) > 1 else None
  
  if arg == '--kill':
    stop()
  elif arg == '--daemon':
    start(daemon=True)
  elif arg is None:
    start(daemon=False)
  else:
    print('Usage: python3 launcher.py [--daemon | --kill]')