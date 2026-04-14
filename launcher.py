#!/usr/bin/env python3
import subprocess, sys, os, time, socket, signal

PORT = 8765
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def check_server():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(('localhost', PORT))
        s.close()
        return True
    except:
        return False

def start(daemon=False):
    if check_server():
        print("MPVise server already running on http://localhost:8765")
        return
    
    print("Starting MPVise...")
    
    proc = subprocess.Popen(
        [sys.executable, os.path.join(SCRIPT_DIR, 'daemon.py')],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True
    )
    
    time.sleep(1)
    
    if check_server():
        if daemon:
            print(f"Running in background (PID: {proc.pid})")
            print("Stays active until restart or: python3 launcher.py --kill")
            sys.exit(0)
        else:
            print(f"MPVise started on http://localhost:8765")
            print("Press Ctrl+C to stop")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                print("\nStopping...")
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    else:
        print("Failed to start")

def stop():
    if not check_server():
        print("Server not running")
        return
    
    print("Stopping MPVise...")
    subprocess.run(['pkill', '-f', 'daemon.py'], capture_output=True)
    print("Stopped")

if __name__ == '__main__':
    if len(sys.argv) > 1:
        if sys.argv[1] == '--kill':
            stop()
        elif sys.argv[1] == '--daemon':
            start(daemon=True)
        else:
            print("Usage: python3 launcher.py [--daemon | --kill]")
    else:
        start(daemon=False)