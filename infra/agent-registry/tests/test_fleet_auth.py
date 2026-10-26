"""Agent registry fleet auth (S3). Offline: Qdrant/Ollama calls are replaced by fakes, requests go straight into the ASGI app.

Run in the built image:  docker compose run --rm agent-registry python -m unittest discover -s tests -v
The generic token/mode behaviour is covered by infra/event-bus/tests (fleet_auth.py is the same file in both services).
"""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('QDRANT_URL', 'http://127.0.0.1:9')
os.environ.setdefault('QDRANT_API_KEY', 'test-only')
os.environ['KNOWLEDGE_MCP_URL'] = 'http://127.0.0.1:9'

import main  # noqa: E402

TOKEN = 'e' * 64
AGENT = next(iter(main.registry))


def call(method, path, headers=None, body=None):
    raw = json.dumps(body).encode() if body is not None else b''

    async def run():
        messages, sent = [], False

        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {'type': 'http.request', 'body': raw, 'more_body': False}
            await asyncio.Future()

        async def send(message):
            messages.append(message)

        path_only, _, query = path.partition('?')
        all_headers = {'host': '100.86.47.122:8088', 'content-type': 'application/json', **(headers or {})}
        await main.app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': method, 'scheme': 'http',
                        'path': path_only, 'raw_path': path_only.encode(), 'query_string': query.encode(), 'root_path': '',
                        'headers': [(k.encode(), v.encode()) for k, v in all_headers.items()], 'client': ('100.78.97.2', 50000),
                        'server': ('testserver', 8088)}, receive, send)
        return messages

    messages = asyncio.run(run())
    status = next(m['status'] for m in messages if m['type'] == 'http.response.start')
    data = b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body')
    return status, (json.loads(data) if data else None)


PROTECTED = [
    ('POST', '/memory/write', {'text': 'remember this', 'source_agent': 'hermes-eve-v'}),
    ('POST', '/memory/search', {'query': 'x'}),
    ('DELETE', '/memory/00000000-0000-0000-0000-000000000000', None),
    ('POST', '/context/forward', {'from_agent': 'x', 'to_agent': AGENT, 'message': 'do this', 'relevant_memories': []}),
    ('POST', f'/knowledge/agent/{AGENT}/register', {'url': 'http://attacker.example'}),
    ('POST', f'/agents/{AGENT}/heartbeat', {'status': 'online'}),
    ('GET', '/memory/list', None),
    ('GET', '/memory/list/', None),
    ('GET', '/knowledge/search?q=secret', None),
    ('GET', f'/context/receive/{AGENT}', None),
    ('HEAD', '/memory/list', None),
]


class AgentRegistryAuthTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        tokens = Path(self.dir.name) / 'tokens'
        tokens.write_text(f'djimit-Eve-V {hashlib.sha256(TOKEN.encode()).hexdigest()}\n')
        self._env = dict(os.environ)
        os.environ['FLEET_TOKENS_FILE'] = str(tokens)
        os.environ.pop('AUTH_MODE', None)
        self.calls = []
        main.write_memory = lambda text, source_agent, metadata=None: self.calls.append('write') or {'id': 'm1', 'text': text}
        main.search_memories = lambda query, source_agent=None, limit=10: self.calls.append('search') or []
        main.list_memories = lambda limit=50: self.calls.append('list') or [{'id': 'm1', 'text': 'private memory'}]
        main.delete_memory = lambda memory_id: self.calls.append('delete') or {'deleted': memory_id}
        main.refresh_registry = lambda: {'status': 'VALID'}
        self._sources = dict(main._KNOWLEDGE_SOURCES)
        main.context_queue.clear()
        main.app.middleware_stack = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        main._KNOWLEDGE_SOURCES.clear()
        main._KNOWLEDGE_SOURCES.update(self._sources)
        self.dir.cleanup()

    def test_enforce_refuses_every_write_and_memory_read_without_a_token(self):
        os.environ['AUTH_MODE'] = 'enforce'
        for method, path, body in PROTECTED:
            with self.subTest(method=method, path=path):
                self.assertEqual(call(method, path, None, body)[0], 401)
                self.assertEqual(call(method, path, {'authorization': 'Bearer wrong'}, body)[0], 401)
        self.assertEqual(self.calls, [])
        self.assertNotIn('attacker', json.dumps(main._KNOWLEDGE_SOURCES))
        self.assertEqual(main.context_queue, {})

    def test_enforce_serves_them_with_a_host_token(self):
        os.environ['AUTH_MODE'] = 'enforce'
        auth = {'authorization': f'Bearer {TOKEN}'}
        self.assertEqual(call('POST', '/memory/write', auth, {'text': 't', 'source_agent': 'hermes-eve-v'})[0], 200)
        self.assertEqual(call('GET', '/memory/list', auth), (200, {'results': [{'id': 'm1', 'text': 'private memory'}], 'count': 1}))
        self.assertEqual(call('DELETE', '/memory/m1', auth)[0], 200)
        self.assertEqual(call('POST', '/context/forward', auth, {'from_agent': 'x', 'to_agent': AGENT, 'message': 'm', 'relevant_memories': []})[0], 200)
        self.assertEqual(self.calls, ['write', 'list', 'delete', 'write'])
        self.assertEqual(call('GET', '/auth/status')[1]['authenticated'], {'djimit-Eve-V': 4})

    def test_agent_topology_and_health_reads_stay_open(self):
        os.environ['AUTH_MODE'] = 'enforce'
        for path in ('/agents', f'/agents/{AGENT}', '/topology', '/health', '/knowledge/sources', '/daps/status'):
            with self.subTest(path=path):
                self.assertEqual(call('GET', path)[0], 200)

    def test_log_mode_serves_and_records_the_self_declared_source(self):
        with self.assertLogs('fleet_auth', 'WARNING') as logs:
            self.assertEqual(call('POST', '/memory/write', None, {'text': 't', 'source_agent': 'hermes-eve-v'})[0], 200)
            self.assertEqual(call('GET', '/memory/list')[0], 200)
        self.assertIn('unauthenticated write service=agent-registry mode=log method=POST path=/memory/write client=100.78.97.2', logs.output[0])
        self.assertIn('source=hermes-eve-v count=1', logs.output[0])
        self.assertIn('unauthenticated memory_read', logs.output[1])
        self.assertEqual(self.calls, ['write', 'list'])


if __name__ == '__main__':
    unittest.main()
