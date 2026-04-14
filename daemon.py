#!/usr/bin/env python3
import json, subprocess, signal, os
from http.server import HTTPServer, BaseHTTPRequestHandler

def handler(sig, frame):
  os._exit(0)

signal.signal(signal.SIGINT, handler)

PORT = 8765

class H(BaseHTTPRequestHandler):
  def do_GET(self):
    if self.path == '/ping':
      self.send_response(200); self.end_headers()
    else: self.send_response(404); self.end_headers()

  def do_POST(self):
    if self.path != '/play': return
    d = json.loads(self.rfile.read(int(self.headers['Content-Length'],0)))
    if d.get('url'): 
      print('[MPVise] Playing:', d['url'])
      subprocess.Popen(['mpv', d['url']])
    self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":1}')

print('MPVise daemon: http://localhost:', PORT)
HTTPServer(('localhost', PORT), H).serve_forever()