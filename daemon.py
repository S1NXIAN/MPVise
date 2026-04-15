#!/usr/bin/env python3
import os
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import json, subprocess, signal, os
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8765
TIMEOUT = 15

def handler(sig, frame):
  os._exit(0)

signal.signal(signal.SIGINT, handler)

def extractStream(url):
  fallback_used = False
  extraction_failed = False
  
  for use_cookies in [True, False]:
    cmd = ['yt-dlp']
    if use_cookies:
      cmd.extend(['--cookies-from-browser', 'chrome'])
    cmd.extend(['-f', 'best', '--no-download', '--print', 'url', '--', url])
    
    try:
      res = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
      candidate = res.stdout.strip()
      if candidate and candidate.startswith('http'):
        return candidate, True, False
      extraction_failed = True
    except:
      extraction_failed = True
  
  return url, fallback_used, extraction_failed

class Handler(BaseHTTPRequestHandler):
  def do_GET(self):
    if self.path == '/ping':
      self.send_response(200)
      self.end_headers()
    else:
      self.send_response(404)
      self.end_headers()

  def do_POST(self):
    if self.path != '/play':
      return
    
    length = int(self.headers.get('Content-Length', 0))
    data = json.loads(self.rfile.read(length))
    url = data.get('url')
    use_fallback = data.get('fallback', True)
    
    if not url:
      self.send_response(400)
      self.end_headers()
      return
    
    print(f'[MPVise] Playing: {url}')
    
    if use_fallback:
      stream_url, fallback_used, extraction_failed = extractStream(url)
      response = {'ok': 1}
      if fallback_used:
        response['fallback'] = True
      if extraction_failed and not fallback_used:
        response['failed'] = True
      self.send_response(200)
      self.send_header('Content-Type', 'application/json')
      self.end_headers()
      self.wfile.write(json.dumps(response).encode())
      if fallback_used or not extraction_failed:
        subprocess.Popen(['mpv', stream_url])
    else:
      self.send_response(200)
      self.send_header('Content-Type', 'application/json')
      self.end_headers()
      self.wfile.write(b'{"ok":1}')
      subprocess.Popen(['mpv', url])

print(f'MPVise daemon: http://localhost:{PORT}')
HTTPServer(('localhost', PORT), Handler).serve_forever()