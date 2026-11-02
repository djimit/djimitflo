"""Per-host bearer auth for the Djimit fleet event bus and agent registry (SECURITY_GAPS S3).

AUTH_MODE = off | log (default) | enforce
  off     - no check at all (the rollback switch).
  log     - a protected request without a valid token is served exactly as before and logged: client address, Host
            header, method, path, the body's self-declared source and a running count. Valid tokens are counted per host.
  enforce - a protected request without a valid token gets 401 and never reaches the route.
Which requests are protected is the service's decision (the `protected` callable): writes always; reads only when they
return memory contents.

Tokens: one per host, generated on that host (`openssl rand -hex 32` into ~/.djimit/fleet-bus.token, mode 600) and sent
as `Authorization: Bearer <token>`. This service holds only the sha256 of each token, in FLEET_TOKENS_FILE (default
/run/fleet/tokens), one line per host:
    <host> <sha256 hex of the token>
so the file on the VPS, and anything copied to it, is not a usable secret. The file is re-read when its mtime changes
(adding, rotating or revoking a host needs no restart). A missing or unreadable file means no known hosts: in enforce
every protected request is refused (fail closed). Token values are never logged, echoed or stored.

Identity model shared with Djimitflo's fleet event signatures (fleet_event_keys): per host name, server-side registry,
nothing taken from the request except the bearer. The secret is deliberately a different one: a bearer travels with
every request, the signing key (~/.djimit/fleet-event.key) must never leave its host.

Stdlib only; a pure ASGI middleware so it can read the body (for the source field) and still hand it to the route.
"""
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import threading
import time
from collections import Counter

MODES = ('off', 'log', 'enforce')
WRITE_METHODS = frozenset({'POST', 'PUT', 'PATCH', 'DELETE'})
HOST_RE = re.compile(r'^[A-Za-z0-9._:-]{1,80}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
UNSAFE = re.compile(r'[^A-Za-z0-9._:/@-]')
SOURCE_FIELDS = ('source', 'source_agent', 'from_agent', 'agent')
MAX_COUNTER_KEYS = 1000
MAX_PARSED_BODY = 256 * 1024
STATUS_PATH = '/auth/status'

log = logging.getLogger('fleet_auth')
if not log.handlers:
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(logging.Formatter('%(levelname)s:     fleet_auth %(message)s'))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False


def auth_mode(env=None):
    """The current mode; an unknown value is treated as the default (log), and the middleware warns about it."""
    value = (os.environ if env is None else env).get('AUTH_MODE', 'log').strip().lower()
    return value if value in MODES else 'log'


def clean(value, limit=80):
    """A value that is safe to put in a log line (no newlines, no control characters), or '-'."""
    text = UNSAFE.sub('_', str(value))[:limit] if value not in (None, '') else ''
    return text or '-'


def token_digest(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


class TokenRegistry:
    """host -> sha256(token), loaded from the tokens file and reloaded when the file's mtime changes."""

    def __init__(self, path):
        self.path = path
        self._stamp = None
        self._entries = []
        self._lock = threading.Lock()

    def _refresh(self):
        try:
            st = os.stat(self.path)
            stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
        except OSError:
            stamp = None
        if stamp == self._stamp:
            return
        with self._lock:
            if stamp == self._stamp:
                return
            entries = {}
            if stamp is not None:
                try:
                    with open(self.path, encoding='utf-8') as handle:
                        lines = handle.read().splitlines()
                except OSError:
                    lines = []
                for number, line in enumerate(lines, 1):
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    parts = line.split()
                    if len(parts) != 2 or not HOST_RE.match(parts[0]) or not SHA256_RE.match(parts[1].lower()):
                        log.warning('tokens file line %d ignored (expected "<host> <sha256 hex>")', number)
                        continue
                    if parts[0] in entries:
                        log.warning('tokens file line %d: host %s listed twice, the last line wins', number, parts[0])
                    entries[parts[0]] = parts[1].lower()
            self._entries = sorted(entries.items())
            self._stamp = stamp
            log.info('tokens file %s: %d host(s) %s', 'loaded' if stamp else 'absent', len(self._entries),
                     ','.join(host for host, _ in self._entries) or '-')

    def hosts(self):
        self._refresh()
        return [host for host, _ in self._entries]

    def verify(self, authorization):
        """The host whose token this `Authorization` header carries, else None. Compares every entry in constant time."""
        self._refresh()
        if not authorization:
            return None
        scheme, _, token = authorization.strip().partition(' ')
        token = token.strip()
        if scheme.lower() != 'bearer' or not token:
            return None
        digest = token_digest(token)
        match = None
        for host, expected in self._entries:
            if hmac.compare_digest(digest, expected):
                match = host
        return match


def _body_source(body):
    if not body or len(body) > MAX_PARSED_BODY:
        return '-'
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return '-'
    if isinstance(data, dict):
        for field in SOURCE_FIELDS:
            if isinstance(data.get(field), str) and data[field]:
                return clean(data[field])
    return '-'


class FleetAuth:
    """ASGI middleware: `app.add_middleware(FleetAuth, service='event-bus', protected=fn)`.

    protected(method, path) returns None (open) or a label such as 'write' / 'memory_read'.
    """

    def __init__(self, app, service, protected, tokens_file=None, env=None):
        self.app = app
        self.service = clean(service)
        self.protected = protected
        self.env = env
        self.tokens = TokenRegistry(tokens_file or (os.environ if env is None else env).get('FLEET_TOKENS_FILE', '/run/fleet/tokens'))
        self.authenticated = Counter()
        self.unauthenticated = Counter()
        self.since = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        self._lock = threading.Lock()
        raw = (os.environ if env is None else env).get('AUTH_MODE', 'log')
        if raw.strip().lower() not in MODES:
            log.warning('AUTH_MODE=%s is not one of off|log|enforce; using log', clean(raw, 20))
        log.info('service=%s mode=%s hosts=%s', self.service, auth_mode(env), ','.join(self.tokens.hosts()) or '-')

    def _count(self, counter, key):
        with self._lock:
            if key not in counter and len(counter) >= MAX_COUNTER_KEYS:
                key = ('(other)',) * len(key) if isinstance(key, tuple) else '(other)'
            counter[key] += 1
            return counter[key]

    def status(self, mode):
        with self._lock:
            unauth = [dict(zip(('kind', 'method', 'path', 'client', 'host_header', 'source'), key), count=n)
                      for key, n in self.unauthenticated.most_common(200)]
            auth = dict(sorted(self.authenticated.items()))
        return {'service': self.service, 'mode': mode, 'since': self.since, 'known_hosts': self.tokens.hosts(),
                'authenticated': auth, 'unauthenticated': unauth}

    async def __call__(self, scope, receive, send):
        if scope.get('type') != 'http':
            await self.app(scope, receive, send)
            return
        mode = auth_mode(self.env)
        method = scope.get('method', 'GET').upper()
        path = scope.get('path', '')
        if method == 'GET' and path == STATUS_PATH:
            await _json(send, 200, self.status(mode))
            return
        kind = self.protected(method, path)
        if mode == 'off' or kind is None:
            await self.app(scope, receive, send)
            return
        headers = {}
        for name, value in scope.get('headers') or []:
            headers.setdefault(name.decode('latin-1').lower(), value.decode('latin-1'))
        host = self.tokens.verify(headers.get('authorization'))
        if host is not None:
            self._count(self.authenticated, host)
            scope.setdefault('state', {})['fleet_host'] = host
            await self.app(scope, receive, send)
            return
        body, receive = await _buffer(receive) if method in WRITE_METHODS else (b'', receive)
        client = (scope.get('client') or ('-',))[0]
        key = (clean(kind), method, clean(path, 200), clean(client), clean(headers.get('host')), _body_source(body))
        count = self._count(self.unauthenticated, key)
        log.warning('unauthenticated %s service=%s mode=%s method=%s path=%s client=%s host_header=%s source=%s count=%d%s',
                    key[0], self.service, mode, method, key[2], key[3], key[4], key[5], count,
                    ' -> 401' if mode == 'enforce' else '')
        if mode == 'enforce':
            await _json(send, 401, {'detail': 'fleet bearer token required'}, [(b'www-authenticate', b'Bearer')])
            return
        await self.app(scope, receive, send)


async def _buffer(receive):
    """Reads the whole request body and returns it with a receive() that replays it to the route."""
    chunks = []
    while True:
        message = await receive()
        if message['type'] != 'http.request':
            break
        chunks.append(message.get('body', b''))
        if not message.get('more_body'):
            break
    body = b''.join(chunks)
    replayed = False

    async def replay():
        nonlocal replayed
        if not replayed:
            replayed = True
            return {'type': 'http.request', 'body': body, 'more_body': False}
        return await receive()

    return body, replay


async def _json(send, status, payload, extra_headers=()):
    data = json.dumps(payload).encode('utf-8')
    await send({'type': 'http.response.start', 'status': status,
                'headers': [(b'content-type', b'application/json'), (b'content-length', str(len(data)).encode()), *extra_headers]})
    await send({'type': 'http.response.body', 'body': data})
