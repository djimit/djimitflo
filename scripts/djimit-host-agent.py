#!/usr/bin/env python3
"""Djimit host agent: the host pulls, Djimitflo never connects to it (operator rule 2026-09-29).

Every INTERVAL seconds: POST /api/host-agent/poll (heartbeat + host info) with this host's token, run what comes back,
POST the result. Two kinds of command:
  diagnostic  a fixed name (ping, uptime, disk, failed-services, top) mapped to this host's own read-only command below;
              nothing the operator typed reaches a shell
  shell       any command, run as root (sudo -n /bin/sh -c ...) — the server only hands it out after a human approved
              exactly this text; the agent re-checks its sha256 before running it
Stdlib only, Python >= 3.9 (the Mac mini). Configure with env or flags:
  DJIMIT_API (default http://100.86.47.122:3001/api)  DJIMIT_HOST  DJIMIT_HOST_TOKEN_FILE  DJIMIT_INTERVAL (30)
  DJIMIT_COMMAND_TIMEOUT (300)  DJIMIT_AGENT_ROOT (1: run shell commands via sudo -n; 0: as this user)
Root needs a sudoers entry for the agent user, e.g. /etc/sudoers.d/djimit-host-agent:
  djimit ALL=(root) NOPASSWD: /bin/sh
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

VERSION = "2"
MAX_OUTPUT = 64 * 1024

DIAGNOSTICS = {
    "linux": {
        "ping": None,
        "uptime": ["uptime"],
        "disk": ["df", "-h", "-x", "tmpfs", "-x", "devtmpfs"],
        "failed-services": ["sh", "-c", "systemctl --failed --no-pager --no-legend; echo '-- user:'; systemctl --user --failed --no-pager --no-legend"],
        "top": ["sh", "-c", "ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -15"],
    },
    "darwin": {
        "ping": None,
        "uptime": ["uptime"],
        "disk": ["df", "-h", "/"],
        "failed-services": ["sh", "-c", "launchctl list | awk 'NR>1 && $2 != \"0\" && $2 != \"-\"'"],
        "top": ["sh", "-c", "ps -Ao pid,pcpu,pmem,etime,comm -r | head -15"],
    },
}


# Ecosystem components worth showing on /fleet (not every OS service): matched on unit / launchd label names.
COMPONENT_PATTERN = re.compile(
    r"djimit|hermes|openclaw|overwatch|scallop|ollama|llama|litellm|deer-?flow|qdrant|uams|knowledge|research|registry|"
    r"event-bus|agent-router|kbwiki|roborev|gym|kb-sync|systemone|nginx|pm2|postgres|redis|mariadb|next", re.I)
_components = {"at": 0.0, "list": []}


def _lines(argv):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=15).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return []


def components(max_age=300):
    """Running Docker containers plus Djimit-relevant services, refreshed every 5 min (the heartbeat stays cheap)."""
    if time.time() - _components["at"] < max_age:
        return _components["list"]
    found = ["docker:" + n for n in _lines(["docker", "ps", "--format", "{{.Names}}"]) if n.strip()]
    if sys.platform == "darwin":
        labels = [line.split("\t")[-1] for line in _lines(["launchctl", "list"])[1:]]
        # Apple's own agents and per-launch app labels are not ecosystem components
        found += ["launchd:" + label for label in labels if COMPONENT_PATTERN.search(label) and not label.startswith(("com.apple.", "application."))]
    else:
        for scope, argv in (("systemd", ["systemctl"]), ("user", ["systemctl", "--user"])):
            units = [line.split()[0] for line in _lines(argv + ["list-units", "--type=service", "--state=running", "--no-legend", "--plain"]) if line.strip()]
            found += ["%s:%s" % (scope, u[:-8] if u.endswith(".service") else u) for u in units if COMPONENT_PATTERN.search(u)]
    _components.update(at=time.time(), list=sorted(set(found))[:80])
    return _components["list"]


def parse_rocm_power(text):
    """Summed GPU package power (W) from `rocm-smi --showpower --json` ({"card0": {"... Package Power (W)": "45.0"}}); None if absent."""
    try:
        data = json.loads(text or "")
    except ValueError:
        return None
    total, found = 0.0, False
    for card in (data.values() if isinstance(data, dict) else []):
        for key, val in (card.items() if isinstance(card, dict) else []):
            k = key.lower()
            if "power" in k and "(w)" in k and "max" not in k and "cap" not in k:
                try:
                    total, found = total + float(val), True
                except (TypeError, ValueError):
                    pass
                break
    return round(total, 1) if found else None


def parse_nvidia_power(text):
    """Summed power.draw (W) from `nvidia-smi --query-gpu=power.draw --format=csv,noheader` ("45.32 W" per GPU); None if absent."""
    vals = []
    for line in (text or "").splitlines():
        try:
            vals.append(float(line.strip().split()[0]))
        except (IndexError, ValueError):
            pass  # "[N/A]" on GPUs without a power sensor
    return round(sum(vals), 1) if vals else None


def gpu_power():
    """E1: this host's GPU package power right now, read-only; None when neither rocm-smi nor nvidia-smi exists or answers."""
    if shutil.which("rocm-smi"):
        w = parse_rocm_power("\n".join(_lines(["rocm-smi", "--showpower", "--json"])))
        if w is not None:
            return {"gpu_watts": w, "source": "rocm-smi"}
    if shutil.which("nvidia-smi"):
        w = parse_nvidia_power("\n".join(_lines(["nvidia-smi", "--query-gpu=power.draw", "--format=csv,noheader"])))
        if w is not None:
            return {"gpu_watts": w, "source": "nvidia-smi"}
    return None


def host_info():
    info = {"os": sys.platform, "hostname": socket.gethostname(), "python": platform.python_version(), "components": components()}
    power = gpu_power()
    if power:
        info["power"] = power
    try:
        info["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        pass
    try:
        du = shutil.disk_usage("/")
        info["disk_root_pct"] = round(100 * du.used / du.total, 1)
    except OSError:
        pass
    return info


def run(argv, timeout):
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")[-MAX_OUTPUT:]
    except subprocess.TimeoutExpired as e:
        out = (e.output or b"").decode("utf-8", "replace")
        return 124, (out + "\n[timed out after %ss]" % timeout)[-MAX_OUTPUT:]
    except OSError as e:
        return 127, str(e)


def execute(cmd, root=True, timeout=300, platform_name=None):
    """Returns (exit_code, output) for one command dict from the server."""
    table = DIAGNOSTICS.get(platform_name or ("darwin" if sys.platform == "darwin" else "linux"), DIAGNOSTICS["linux"])
    if cmd.get("kind") == "diagnostic":
        name = cmd.get("command")
        if name not in table:
            return 2, "unknown diagnostic: %s" % name
        if table[name] is None:
            return 0, "pong from %s" % socket.gethostname()
        return run(table[name], 60)
    if cmd.get("kind") != "shell":
        return 2, "unknown command kind"
    text = cmd.get("command") or ""
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != cmd.get("sha256"):
        return 3, "refused: command text does not match its approved sha256"
    argv = ["sudo", "-n", "/bin/sh", "-c", text] if root else ["/bin/sh", "-c", text]
    code, out = run(argv, timeout)
    if root and code == 1 and "a password is required" in out:
        return 126, "refused: sudo is not configured for this agent (see the sudoers entry in scripts/djimit-host-agent.py)\n" + out
    return code, out


def post(api, path, host, token, body):
    req = urllib.request.Request(api.rstrip("/") + path, json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "X-Host": host, "X-Host-Token": token})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read() or b"{}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("DJIMIT_API", "http://100.86.47.122:3001/api"))
    ap.add_argument("--host", default=os.environ.get("DJIMIT_HOST", socket.gethostname()))
    ap.add_argument("--token-file", default=os.environ.get("DJIMIT_HOST_TOKEN_FILE", os.path.expanduser("~/.djimit/host-agent.token")))
    ap.add_argument("--interval", type=int, default=int(os.environ.get("DJIMIT_INTERVAL", "30")))
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("DJIMIT_COMMAND_TIMEOUT", "300")))
    ap.add_argument("--no-root", action="store_true", default=os.environ.get("DJIMIT_AGENT_ROOT", "1") == "0")
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    with open(args.token_file) as f:
        token = f.read().strip()
    backoff = args.interval
    while True:
        try:
            commands = post(args.api, "/host-agent/poll", args.host, token, {"version": VERSION, "info": host_info()}).get("commands", [])
            for cmd in commands:
                code, out = execute(cmd, root=not args.no_root, timeout=args.timeout)
                post(args.api, "/host-agent/commands/%s/result" % cmd["id"], args.host, token, {"exit_code": code, "output": out})
                print("%s %s %s -> %s" % (time.strftime("%H:%M:%S"), cmd.get("kind"), cmd.get("id", "")[:8], code), flush=True)
            backoff = args.interval
        except Exception as e:  # keep polling; the server may be deploying
            print("poll failed: %s" % e, file=sys.stderr, flush=True)
            backoff = min(backoff * 2, 600)
        if args.once:
            return
        time.sleep(backoff)


def selfcheck():
    assert execute({"kind": "diagnostic", "command": "ping"})[1].startswith("pong from ")
    assert execute({"kind": "diagnostic", "command": "rm -rf /"})[0] == 2
    text = "echo hello"
    assert execute({"kind": "shell", "command": text, "sha256": "0" * 64}, root=False)[0] == 3
    code, out = execute({"kind": "shell", "command": text, "sha256": hashlib.sha256(text.encode()).hexdigest()}, root=False)
    assert code == 0 and out.strip() == "hello", (code, out)
    assert execute({"kind": "shell", "command": "sleep 5", "sha256": hashlib.sha256(b"sleep 5").hexdigest()}, root=False, timeout=1)[0] == 124
    assert "os" in host_info()
    assert isinstance(host_info()["components"], list)
    assert COMPONENT_PATTERN.search("hermes-gateway") and not COMPONENT_PATTERN.search("cups")
    rocm = '{"card0": {"Current Socket Graphics Package Power (W)": "212.0"}, "card1": {"Average Graphics Package Power (W)": "17.5"}}'
    assert parse_rocm_power(rocm) == 229.5 and parse_rocm_power("not json") is None and parse_rocm_power('{"card0": {}}') is None
    assert parse_nvidia_power("45.32 W\n[N/A]\n120.00 W\n") == 165.3 and parse_nvidia_power("") is None
    # fake tools on PATH: rocm-smi wins, an unparseable rocm-smi falls back to nvidia-smi, neither present -> no reading
    import tempfile
    old_path = os.environ.get("PATH", "")
    with tempfile.TemporaryDirectory() as d:
        def fake(name, out):
            path = os.path.join(d, name)
            with open(path, "w") as f:
                f.write("#!/bin/sh\nprintf '%%s\\n' '%s'\n" % out)  # builtin only: PATH holds just the fakes
            os.chmod(path, 0o755)
        try:
            os.environ["PATH"] = d
            assert gpu_power() is None
            fake("nvidia-smi", "88.10 W")
            assert gpu_power() == {"gpu_watts": 88.1, "source": "nvidia-smi"}
            fake("rocm-smi", "garbage")
            assert gpu_power() == {"gpu_watts": 88.1, "source": "nvidia-smi"}
            fake("rocm-smi", rocm)
            assert gpu_power() == {"gpu_watts": 229.5, "source": "rocm-smi"}
        finally:
            os.environ["PATH"] = old_path
    print("selfcheck ok")


if __name__ == "__main__":
    selfcheck() if sys.argv[1:] == ["--selfcheck"] else main()
