#!/usr/bin/env python3
"""Plan N2: report one unit of agent work to Djimitflo (event `agent.outcome` on the Djimit event bus).

Djimitflo stores it as skill outcome `agent:<agent>:<task_kind>` and ranks agents x models across the fleet.
Stdlib only, Python 3.9-safe (Mac mini). Never raises into the caller: exit 0 even when the bus is down.

  emit-agent-outcome.py --agent hermes-eve-v --task-kind briefing --success true [--model kimi-k3] [--tokens 1200] \
      [--duration-ms 5400] [--ref https://...] [--skill blog-publisher --skill-file ~/.hermes/skills/x/blog-publisher/SKILL.md] [--dry-run]
  emit-agent-outcome.py --selfcheck

Skill identity (skill inventory 2026-10-26, intervention 1): --skill names the skill that ran; --skill-file is its installed
SKILL.md, sent as skill_sha = sha256 hex of the file's bytes with trailing newlines (\n) removed, so a file saved with or
without a final newline hashes the same. Nothing else is normalised (no BOM/CRLF/whitespace rewriting): any other byte change
is a different skill. An unreadable file sends no skill_sha (never a guessed one) and does not fail; a name outside
[A-Za-z0-9][A-Za-z0-9_.-]{0,63} is dropped with a warning.

P0-3 signing: when the key file exists (DJIMIT_FLEET_EVENT_KEY_FILE, default ~/.djimit/fleet-event.key, mode 600; one line
`<host> <key_id> <secret>`, minted by the operator inside the Djimitflo container) the event gets host, key_id,
sig_alg=hmac-sha256 and sig. HMAC-SHA256, not Ed25519: Python's stdlib has no Ed25519 and this script stays stdlib-only;
the server verifier accepts both. Signed bytes: canonical JSON (sorted keys, no spaces) of {agent, event_id, host,
payload_sha256, success, task_kind, ts}, payload_sha256 = sha256 hex of canonical JSON of the present optional fields
(duration_ms, model, ref, skill, skill_sha, tokens) as strings. No key file -> the event is sent unsigned, exactly as before.
"""
import argparse, base64, hashlib, hmac, json, os, re, sys, tempfile, time, urllib.request, uuid

KEY_FILE = os.environ.get('DJIMIT_FLEET_EVENT_KEY_FILE', os.path.expanduser('~/.djimit/fleet-event.key'))
PAYLOAD_FIELDS = ('duration_ms', 'model', 'ref', 'skill', 'skill_sha', 'tokens')
SKILL_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')  # mirrors agentOutcomeSchema.skill on the server
SKILL_FILE_MAX = 4 * 1024 * 1024


def skill_sha256(path):
    """sha256 hex of SKILL.md minus trailing newlines, or None when the file is unreadable (never raises)."""
    try:
        with open(os.path.expanduser(path), 'rb') as f:
            data = f.read(SKILL_FILE_MAX + 1)
    except (OSError, TypeError, ValueError):
        return None
    if len(data) > SKILL_FILE_MAX:
        return None
    return hashlib.sha256(data.rstrip(b'\n')).hexdigest()


SKILL_VECTOR = 'CtEQsJJJDMtJV--q2gRaCWzhUsMXHz5LyyJQFE8TBqA'


def bus_headers():
    """S3 (docs/runbooks/fleet-bus-auth.md): Content-Type plus this host's fleet bus bearer token when it has one
    (DJIMIT_EVENT_BUS_TOKEN, else the file DJIMIT_FLEET_BUS_TOKEN_FILE, default ~/.djimit/fleet-bus.token, mode 600)."""
    token = os.environ.get('DJIMIT_EVENT_BUS_TOKEN', '').strip()
    if not token:
        try:
            with open(os.environ.get('DJIMIT_FLEET_BUS_TOKEN_FILE', os.path.expanduser('~/.djimit/fleet-bus.token'))) as f:
                token = f.read().strip()
        except OSError:
            token = ''
    return {'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def signed_body(event):
    payload = {f: str(event[f]) for f in PAYLOAD_FIELDS if event.get(f) is not None}
    return canonical({'agent': event['agent'], 'event_id': event['event_id'], 'host': event['host'],
                      'payload_sha256': hashlib.sha256(canonical(payload).encode('utf-8')).hexdigest(),
                      'success': event['success'], 'task_kind': event['task_kind'], 'ts': event['occurred_at']})


def sign(event, host, key_id, secret):
    """Adds host, key_id, sig_alg and sig in place; the secret itself never enters the event."""
    event.update({'host': host, 'key_id': key_id, 'sig_alg': 'hmac-sha256'})
    mac = hmac.new(secret.encode('utf-8'), signed_body(event).encode('utf-8'), hashlib.sha256).digest()
    event['sig'] = base64.urlsafe_b64encode(mac).decode('ascii').rstrip('=')
    return event


def load_key(path=KEY_FILE):
    """(host, key_id, secret) or None when there is no usable key file (then the event goes unsigned)."""
    try:
        with open(path) as f:
            parts = f.read().split()
    except OSError:
        return None
    if len(parts) != 3:
        print('fleet event key file malformed; sending unsigned', file=sys.stderr)
        return None
    return tuple(parts)


def build(agent, task_kind, success, model=None, tokens=None, duration_ms=None, ref=None, skill=None, skill_sha=None):
    event = {'event_id': 'agent-outcome:' + str(uuid.uuid4()), 'event_type': 'agent.outcome', 'source': agent, 'agent': agent,
             'task_kind': task_kind, 'success': bool(success), 'occurred_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if model: event['model'] = model
    if tokens is not None: event['tokens'] = int(tokens)
    if duration_ms is not None: event['duration_ms'] = int(duration_ms)
    if ref: event['ref'] = ref[:300]
    if skill and not SKILL_RE.match(skill):
        print('skill name %r not accepted; sent without skill' % skill[:80], file=sys.stderr)
        skill = None
    if skill:
        event['skill'] = skill
        if skill_sha: event['skill_sha'] = skill_sha
    return event


def send(event, bus, stream):
    """POSTs one event to the bus; True when it was accepted. Never raises (reporting must never break the agent's work)."""
    try:
        req = urllib.request.Request(bus.rstrip('/') + '/events/' + stream, json.dumps(event).encode(), bus_headers())
        urllib.request.urlopen(req, timeout=10).read()
        return True
    except Exception as err:
        print('agent.outcome not sent: ' + str(err), file=sys.stderr)
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent'); ap.add_argument('--task-kind'); ap.add_argument('--success')
    ap.add_argument('--model'); ap.add_argument('--tokens', type=int); ap.add_argument('--duration-ms', type=int); ap.add_argument('--ref')
    ap.add_argument('--skill'); ap.add_argument('--skill-file')
    ap.add_argument('--bus', default=os.environ.get('DJIMIT_EVENT_BUS_URL', 'http://100.86.47.122:8083'))
    ap.add_argument('--stream', default='djimit.events')
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--selfcheck', action='store_true')
    a = ap.parse_args()
    if a.selfcheck:
        e = build('x', 'y', True, tokens=3)
        assert e['event_type'] == 'agent.outcome' and e['success'] is True and e['tokens'] == 3 and 'model' not in e
        # fixed vector shared with the TS verifier test (packages/server/src/__tests__/fleet-event-signatures.test.ts)
        v = sign({'event_id': 'agent-outcome:fixture-1', 'event_type': 'agent.outcome', 'source': 'hermes', 'agent': 'hermes',
                  'task_kind': 'briefing', 'success': True, 'occurred_at': '2026-10-20T08:00:00Z', 'tokens': 1200, 'model': 'kimi-k3'},
                 'macmini', '0123456789abcdef', 'fixture-secret')
        assert v['sig'] == 'sGOwPZ1cvtEUsA1EBpcixRnV2kv8Us2q23n2C9CbT-0', v['sig']
        assert 'fixture-secret' not in json.dumps(v)
        # skill identity: the hash ignores trailing newlines only; an unreadable file gives no hash; a bad name is dropped
        d = tempfile.mkdtemp()
        p1, p2 = os.path.join(d, 'a.md'), os.path.join(d, 'b.md')
        with open(p1, 'wb') as f: f.write(b'---\nname: s\n---\nbody\n')
        with open(p2, 'wb') as f: f.write(b'---\nname: s\n---\nbody')
        h = skill_sha256(p1)
        assert h == skill_sha256(p2) == hashlib.sha256(b'---\nname: s\n---\nbody').hexdigest(), h
        assert skill_sha256(os.path.join(d, 'missing.md')) is None
        os.remove(p1); os.remove(p2); os.rmdir(d)
        s = build('x', 'y', False, skill='blog-publisher', skill_sha=h)
        assert s['skill'] == 'blog-publisher' and s['skill_sha'] == h and s['success'] is False
        assert 'skill_sha' not in build('x', 'y', True, skill='blog-publisher', skill_sha=None)
        assert 'skill' not in build('x', 'y', True, skill='../etc', skill_sha=h) and 'skill_sha' not in build('x', 'y', True, skill='../etc', skill_sha=h)
        # fixed skill vector shared with packages/server/src/__tests__/fleet-skill-identity.test.ts
        w = sign({'event_id': 'agent-outcome:fixture-2', 'event_type': 'agent.outcome', 'source': 'hermes', 'agent': 'hermes',
                  'task_kind': 'briefing', 'success': True, 'occurred_at': '2026-10-20T08:00:00Z', 'skill': 'blog-publisher', 'skill_sha': 'a' * 64},
                 'macmini', '0123456789abcdef', 'fixture-secret')
        assert w['sig'] == SKILL_VECTOR, w['sig']
        print('selfcheck ok (signing ' + ('configured' if load_key() else 'not configured') + ')'); return
    if not (a.agent and a.task_kind and a.success in ('true', 'false')):
        ap.error('--agent, --task-kind and --success true|false are required')
    event = build(a.agent, a.task_kind, a.success == 'true', a.model, a.tokens, a.duration_ms, a.ref,
                  a.skill, skill_sha256(a.skill_file) if (a.skill and a.skill_file) else None)
    key = load_key()
    if key:
        sign(event, *key)
    if a.dry_run:
        print(json.dumps(event)); return
    send(event, a.bus, a.stream)


if __name__ == '__main__':
    main()
