#!/usr/bin/env python3
"""
UAMS SSH Proxy — structurele fix voor MacBook toegang tot workstation UAMS.

Dit script draait een lokale HTTP proxy op localhost:8000 die alle
requests forwardt naar UAMS op de workstation via SSH.

Gebruik:
  python3 scripts/uams-proxy.py start   # Start de proxy
  python3 scripts/uams-proxy.py stop    # Stop de proxy
  python3 scripts/uams-proxy.py status  # Check status
"""

import os
import sys
import signal
import subprocess
import time
import socket
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request
import urllib.error
import json

PID_FILE = ".uams-proxy.pid"
LOCAL_PORT = 8001  # Local proxy port (avoid conflict with tunnel)
WORKSTATION = "djimit@192.168.1.28"
UAMS_PORT = 8000
TUNNEL_PID_FILE = ".uams-tunnel.pid"


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) == 0


def start_tunnel():
    """Start SSH tunnel for UAMS."""
    if is_port_in_use(UAMS_PORT):
        print(f"Poort {UAMS_PORT} al in gebruik — tunnel bestaat waarschijnlijk al")
        return True

    print(f"Start SSH tunnel: localhost:{UAMS_PORT} -> workstation:{UAMS_PORT}")
    proc = subprocess.Popen(
        ["ssh", "-N", "-L", f"{UAMS_PORT}:localhost:{UAMS_PORT}", WORKSTATION],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Wait for tunnel to establish
    for _ in range(10):
        time.sleep(0.5)
        if is_port_in_use(UAMS_PORT):
            print(f"Tunnel gestart (PID: {proc.pid})")
            with open(TUNNEL_PID_FILE, "w") as f:
                f.write(str(proc.pid))
            return True

    print("Tunnel kon niet worden opgezet")
    proc.kill()
    return False


def stop_tunnel():
    """Stop SSH tunnel."""
    if os.path.exists(TUNNEL_PID_FILE):
        pid = int(os.path.read_text(TUNNEL_PID_FILE).strip())
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"Tunnel gestopt (PID: {pid})")
        except ProcessLookupError:
            print(f"Tunnel draait niet (PID: {pid})")
        os.remove(TUNNEL_PID_FILE)
    else:
        print("Geen tunnel PID bestand gevonden")


class UAMSProxyHandler(BaseHTTPRequestHandler):
    """Simple HTTP proxy that forwards requests to UAMS via tunnel."""

    def do_GET(self):
        self.forward_request("GET")

    def do_POST(self):
        self.forward_request("POST")

    def forward_request(self, method: str):
        try:
            # Read request body
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else None

            # Build URL (forward to localhost tunnel)
            url = f"http://localhost:{UAMS_PORT}{self.path}"

            # Create request
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header("Content-Type", "application/json")

            # Add auth token
            api_key = os.environ.get(
                "RESEARCH_AGENT_API_KEY", "djimit-local-research-agent-key-2026"
            )
            req.add_header("Authorization", f"Bearer {api_key}")

            # Forward request
            with urllib.request.urlopen(req, timeout=10) as response:
                self.send_response(response.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(response.read())

        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        pass  # Suppress logging


def start_proxy():
    """Start the UAMS proxy server."""
    if is_port_in_use(LOCAL_PORT):
        print(f"Proxy draait al op poort {LOCAL_PORT}")
        return

    # Start tunnel first
    if not start_tunnel():
        return

    # Start proxy
    server = HTTPServer(("localhost", LOCAL_PORT), UAMSProxyHandler)
    print(f"UAMS proxy draait op http://localhost:{LOCAL_PORT}")
    print(f"Gebruik: curl http://localhost:{LOCAL_PORT}/memory/health")

    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        stop_tunnel()
        os.remove(PID_FILE)


def status():
    """Check proxy and tunnel status."""
    tunnel_active = is_port_in_use(UAMS_PORT)
    proxy_active = is_port_in_use(LOCAL_PORT)

    print(
        f"Tunnel (poort {UAMS_PORT}): {'✅ Actief' if tunnel_active else '❌ Inactief'}"
    )
    print(
        f"Proxy (poort {LOCAL_PORT}): {'✅ Actief' if proxy_active else '❌ Inactief'}"
    )

    if tunnel_active:
        try:
            req = urllib.request.Request(f"http://localhost:{UAMS_PORT}/memory/health")
            req.add_header(
                "Authorization", "Bearer djimit-local-research-agent-key-2026"
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                print(f"UAMS status: {data.get('status', 'unknown')}")
                print(f"Entries: {data.get('total_entries', 'unknown')}")
        except Exception as e:
            print(f"UAMS bereikbaar maar error: {e}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Gebruik: {sys.argv[0]} {{start|stop|status}}")
        sys.exit(1)

    command = sys.argv[1]
    if command == "start":
        start_proxy()
    elif command == "stop":
        stop_tunnel()
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    elif command == "status":
        status()
    else:
        print(f"Onbekend commando: {command}")
        sys.exit(1)
