"""Event bus fleet auth (S3). Offline: Redis is replaced by a fake, requests go straight into the ASGI app.

Run in the built image:  docker compose run --rm --no-deps event-bus python -m unittest discover -s tests -v
"""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('REDIS_PASSWORD', 'test-only')

import fleet_auth  # noqa: E402
import main  # noqa: E402

TOKEN_VPS = 'a' * 64
TOKEN_MACMINI = 'b' * 64
FORGED = 'f0rged-token-value-never-logged'


def sha(token):
    return hashlib.sha256(token.encode()).hexdigest()


class FakeBus:
    def __init__(self):
        self.published = []

    def publish(self, stream, event):
        self.published.append((stream, event))
        return f'{len(self.published)}-0'

    def read(self, stream, count=10):
        return [{'_id': '1-0', 'event_type': 'x'}]

    def list_streams(self):
        return [{'name': 'djimit.events', 'length': 1}]

    def create_consumer_group(self, stream, group):
        return True


def call(app, method, path, headers=None, body=None, client='100.101.220.31'):
    raw = json.dumps(body).encode() if body is not None else b''

    async def run():
        messages, sent = [], False

        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {'type': 'http.request', 'body': raw, 'more_body': False}
            await asyncio.Future()  # never: no disconnect during a test request

        async def send(message):
            messages.append(message)

        path_only, _, query = path.partition('?')
        all_headers = {'host': '100.86.47.122:8083', 'content-type': 'application/json', **(headers or {})}
        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': method, 'scheme': 'http',
                 'path': path_only, 'raw_path': path_only.encode(), 'query_string': query.encode(), 'root_path': '',
                 'headers': [(k.encode(), v.encode()) for k, v in all_headers.items()], 'client': (client, 50000),
                 'server': ('testserver', 8000)}
        await app(scope, receive, send)
        return messages

    messages = asyncio.run(run())
    status = next(m['status'] for m in messages if m['type'] == 'http.response.start')
    data = b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body')
    return status, (json.loads(data) if data else None)


class EventBusAuthTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.tokens = Path(self.dir.name) / 'tokens'
        self.tokens.write_text(f'# host sha256\nvps {sha(TOKEN_VPS)}\nmacmini {sha(TOKEN_MACMINI)}\n')
        self.env = {'FLEET_TOKENS_FILE': str(self.tokens)}
        self.fake = FakeBus()
        main.bus = self.fake
        self._env = dict(os.environ)
        os.environ.update(self.env)
        os.environ.pop('AUTH_MODE', None)
        main.app.middleware_stack = None  # rebuild the stack (and a fresh FleetAuth) for every test

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        self.dir.cleanup()

    def publish(self, headers=None, source='djimitflo-scout'):
        return call(main.app, 'POST', '/events/djimit.events', headers, {'event_type': 'discovery.paper', 'source': source})

    def test_default_mode_is_log_and_serves_unauthenticated_writes_with_a_log_line(self):
        with self.assertLogs('fleet_auth', 'WARNING') as logs:
            status, body = self.publish()
            status2, _ = self.publish()
        self.assertEqual(status, 200)
        self.assertEqual(status2, 200)
        self.assertEqual(len(self.fake.published), 2)
        line = logs.output[-1]
        for part in ('unauthenticated write', 'service=event-bus', 'mode=log', 'method=POST', 'path=/events/djimit.events',
                     'client=100.101.220.31', 'host_header=100.86.47.122:8083', 'source=djimitflo-scout', 'count=2'):
            self.assertIn(part, line)

    def test_enforce_refuses_missing_and_wrong_tokens_and_never_reaches_redis(self):
        os.environ['AUTH_MODE'] = 'enforce'
        with self.assertLogs('fleet_auth', 'WARNING') as logs:
            for headers in (None, {'authorization': f'Bearer {FORGED}'}, {'authorization': TOKEN_VPS},
                            {'authorization': f'Basic {TOKEN_VPS}'}, {'authorization': 'Bearer '}):
                status, body = self.publish(headers)
                self.assertEqual(status, 401, headers)
                self.assertEqual(body, {'detail': 'fleet bearer token required'})
        self.assertEqual(self.fake.published, [])
        self.assertNotIn(FORGED, '\n'.join(logs.output))
        self.assertNotIn(TOKEN_VPS, '\n'.join(logs.output))
        self.assertEqual(call(main.app, 'POST', '/streams/djimit.events/groups?group=g')[0], 401)

    def test_enforce_accepts_each_hosts_token_and_hands_the_body_on_unchanged(self):
        os.environ['AUTH_MODE'] = 'enforce'
        status, body = self.publish({'authorization': f'Bearer {TOKEN_MACMINI}'})
        self.assertEqual((status, body), (200, {'stream': 'djimit.events', 'id': '1-0'}))
        self.assertEqual(self.fake.published, [('djimit.events', {'event_type': 'discovery.paper', 'source': 'djimitflo-scout'})])
        self.assertEqual(self.publish({'authorization': f'bearer {TOKEN_VPS}'})[0], 200)
        status, report = call(main.app, 'GET', '/auth/status')
        self.assertEqual(report['authenticated'], {'macmini': 1, 'vps': 1})
        self.assertEqual(report['known_hosts'], ['macmini', 'vps'])
        self.assertNotIn(sha(TOKEN_VPS), json.dumps(report))

    def test_reads_stay_open_in_enforce(self):
        os.environ['AUTH_MODE'] = 'enforce'
        self.assertEqual(call(main.app, 'GET', '/events/djimit.events?count=5')[0], 200)
        self.assertEqual(call(main.app, 'GET', '/streams')[0], 200)

    def test_off_skips_the_check_and_logs_nothing(self):
        os.environ['AUTH_MODE'] = 'off'
        with self.assertNoLogs('fleet_auth', 'WARNING'):
            self.assertEqual(self.publish()[0], 200)

    def test_an_unknown_mode_falls_back_to_log(self):
        os.environ['AUTH_MODE'] = 'enforced'
        self.assertEqual(self.publish()[0], 200)
        self.assertEqual(call(main.app, 'GET', '/auth/status')[1]['mode'], 'log')

    def test_missing_tokens_file_fails_closed_in_enforce(self):
        os.environ['AUTH_MODE'] = 'enforce'
        self.tokens.unlink()
        self.assertEqual(self.publish({'authorization': f'Bearer {TOKEN_VPS}'})[0], 401)

    def test_tokens_file_changes_apply_without_restart(self):
        os.environ['AUTH_MODE'] = 'enforce'
        self.assertEqual(self.publish({'authorization': f'Bearer {TOKEN_MACMINI}'})[0], 200)
        rotated = 'c' * 64
        time.sleep(0.01)
        self.tokens.write_text(f'vps {sha(TOKEN_VPS)}\nmacmini {sha(rotated)}\nnot a valid line\n')
        os.utime(self.tokens, ns=(time.time_ns() + 10**9,) * 2)
        self.assertEqual(self.publish({'authorization': f'Bearer {TOKEN_MACMINI}'})[0], 401)
        self.assertEqual(self.publish({'authorization': f'Bearer {rotated}'})[0], 200)

    def test_status_lists_unauthenticated_callers_by_source(self):
        self.publish(source='operator-chatgpt')
        self.publish(source='operator-chatgpt')
        self.publish({'authorization': f'Bearer {TOKEN_VPS}'}, source='djimitflo')
        report = call(main.app, 'GET', '/auth/status')[1]
        self.assertEqual(report['mode'], 'log')
        self.assertEqual(report['authenticated'], {'vps': 1})
        self.assertEqual([(u['source'], u['count'], u['kind']) for u in report['unauthenticated']], [('operator-chatgpt', 2, 'write')])

    def test_log_values_are_sanitised(self):
        with self.assertLogs('fleet_auth', 'WARNING') as logs:
            self.publish(source='evil\nINFO: forged line')
        self.assertNotIn('\n', logs.output[-1].split('fleet_auth:', 1)[1])


class TokenRegistryTest(unittest.TestCase):
    def test_compares_every_entry_and_returns_the_matching_host(self):
        with tempfile.NamedTemporaryFile('w', delete=False) as handle:
            handle.write(f'a {sha("x")}\nb {sha("y")}\nc {sha("z")}\n')
        registry = fleet_auth.TokenRegistry(handle.name)
        calls = []
        original = fleet_auth.hmac.compare_digest
        fleet_auth.hmac.compare_digest = lambda a, b: calls.append(1) or original(a, b)
        try:
            self.assertEqual(registry.verify('Bearer x'), 'a')
        finally:
            fleet_auth.hmac.compare_digest = original
            os.unlink(handle.name)
        self.assertEqual(len(calls), 3)  # no early exit on a match


if __name__ == '__main__':
    unittest.main()
