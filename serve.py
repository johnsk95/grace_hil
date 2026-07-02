#!/usr/bin/env python3
"""
Serve the GRACE HITL annotator from this machine.

Usage:
    python serve.py [port]        # default port 8000

Binds 0.0.0.0 so other computers on the SAME network can reach it at the LAN
URL printed on startup. For validators off your network, expose this local
server with a tunnel (see DEPLOY.md → "Reaching validators off your network").

Only Python 3 standard library is used — no dependencies.
"""
import http.server
import os
import socket
import socketserver
import sys
from pathlib import Path

os.chdir(Path(__file__).resolve().parent)   # serve this folder (index.html at root)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Always fetch the freshest pool.json / app.js (no stale caching).
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> None:
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        ip = lan_ip()
        print("Serving GRACE HITL annotator (Ctrl-C to stop):")
        print(f"  this machine : http://localhost:{PORT}/")
        print(f"  same network : http://{ip}:{PORT}/   <- share with validators on your LAN")
        print("  off-network  : run a tunnel (see DEPLOY.md) for a public https URL", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")


if __name__ == "__main__":
    main()
