#!/usr/bin/env python3
"""Read-only-period monitor for the retiring Paperclip: how long since the last write, and by whom?

Counts Paperclip write requests (POST/PATCH/PUT/DELETE) in the nginx access logs (own vhost paths: /api/{issues,routines,agents,
approvals,projects,goals,companies,...} or referer agentical.nl/DJI). Operator-UI writes show up with a browser user agent; agent/routine
traffic that bypasses nginx (localhost:3100) is covered by the journal heartbeat check. Exit 0 = quiet window is running.
Usage: paperclip-readonly-monitor.py [--logs /var/log/nginx/access.log*] [--state FILE] [--days 14] | --selftest
"""
import glob, gzip, json, os, re, subprocess, sys
from datetime import datetime, timezone

LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(POST|PATCH|PUT|DELETE) (\S+)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"')
PAPERCLIP_PATH = re.compile(r'^/(DJI/)?api/(issues|routines|agents|approvals|projects|goals|companies|labels|heartbeat|documents|cost)')

def scan(paths):
    events = []
    for p in paths:
        op = gzip.open if p.endswith(".gz") else open
        with op(p, "rt", errors="replace") as fh:
            for line in fh:
                m = LINE.match(line)
                if not m: continue
                ip, ts, method, path, status, ref, ua = m.groups()
                if int(status) >= 400: continue
                if not (PAPERCLIP_PATH.match(path) or "agentical.nl/DJI" in ref): continue
                events.append((datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z"), method, path.split("?")[0], ip))
    return sorted(events)

def journal_heartbeats(since="-24h"):
    try:
        out = subprocess.run(["journalctl", "-u", "paperclip.service", "--since", since, "--no-pager", "-g", "heartbeat_run|run started"],
                             capture_output=True, text=True, timeout=30).stdout
        return len([l for l in out.splitlines() if l.strip() and not l.startswith("--")])
    except Exception:
        return None

def report(events, days=14, now=None):
    now = now or datetime.now(timezone.utc)
    last = events[-1][0] if events else None
    quiet = (now - last).total_seconds() / 86400 if last else None
    return {"checked_at": now.isoformat(), "writes_total_in_logs": len(events), "last_write": last.isoformat() if last else None,
            "last_write_path": events[-1][2] if events else None, "quiet_days": None if quiet is None else round(quiet, 2),
            "target_days": days, "criterion_met": quiet is None or quiet >= days}

def selftest():
    import tempfile
    d = tempfile.mkdtemp(); p = os.path.join(d, "a.log")
    with open(p, "w") as f:
        f.write('1.1.1.1 - - [21/Sep/2026:11:52:26 +0000] "PATCH /api/routines/x HTTP/1.1" 200 1 "https://agentical.nl/DJI/routines" "ua"\n'
                '1.1.1.1 - - [21/Sep/2026:12:00:00 +0000] "POST /api/swarms/plan HTTP/1.1" 200 1 "https://djimitflo.agentical.nl/x" "ua"\n'
                '1.1.1.1 - - [21/Sep/2026:12:01:00 +0000] "GET /api/issues HTTP/1.1" 200 1 "-" "ua"\n')
    ev = scan([p]); assert len(ev) == 1 and ev[0][2] == "/api/routines/x", ev
    r = report(ev, now=datetime(2026, 10, 6, 12, tzinfo=timezone.utc)); assert r["criterion_met"] and r["quiet_days"] > 14, r
    print("selftest ok")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a == ["--selftest"]: selftest(); sys.exit(0)
    arg = lambda k, d: a[a.index(k) + 1] if k in a else d
    paths = sorted(glob.glob(arg("--logs", "/var/log/nginx/access.log*")))
    r = report(scan(paths), int(arg("--days", 14))); r["journal_heartbeat_lines_24h"] = journal_heartbeats()
    state = arg("--state", None)
    if state:
        with open(state, "w") as f: json.dump(r, f, indent=1)
    print(json.dumps(r)); sys.exit(0 if r["criterion_met"] else 1)
