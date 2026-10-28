"""STATE-NEW-03: shared memory never writes or queries a non-semantic vector in the semantic collection.

Offline: the Ollama HTTP call and the Qdrant client are fakes. When the embedding is unavailable (outage, wrong dimension,
malformed values) the routes answer 503 with a reason and nothing reaches Qdrant; new points record embed_model/embed_dim
and searches only match points of the current model.
"""
import asyncio
import json
import math
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('QDRANT_URL', 'http://127.0.0.1:9')
os.environ.setdefault('QDRANT_API_KEY', 'test-only')
os.environ['KNOWLEDGE_MCP_URL'] = 'http://127.0.0.1:9'

import httpx  # noqa: E402
import main  # noqa: E402
import memory  # noqa: E402

AGENT = next(iter(main.registry))


class FakeQdrant:
    def __init__(self):
        self.upserts, self.queries = [], []

    def get_collections(self):
        return SimpleNamespace(collections=[SimpleNamespace(name=memory.COLLECTION)])

    def upsert(self, collection_name, points):
        self.upserts.extend(points)

    def query_points(self, collection_name, query, query_filter=None, limit=10, with_payload=True):
        self.queries.append({'query': query, 'filter': query_filter})
        return SimpleNamespace(points=[SimpleNamespace(id='p1', score=0.9, payload={'text': 'hit', 'source_agent': 'a'})])


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self.body


def ollama_returns(body):
    return mock.patch.object(httpx, 'post', lambda *a, **k: FakeResponse(body))


def ollama_down():
    def post(*a, **k):
        raise httpx.ConnectError('connection refused')
    return mock.patch.object(httpx, 'post', post)


GOOD = [0.01] * memory.VECTOR_SIZE


def call(method, path, body=None):
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
        headers = {'host': '100.86.47.122:8088', 'content-type': 'application/json'}
        await main.app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': method, 'scheme': 'http',
                        'path': path_only, 'raw_path': path_only.encode(), 'query_string': query.encode(), 'root_path': '',
                        'headers': [(k.encode(), v.encode()) for k, v in headers.items()], 'client': ('100.78.97.2', 50000),
                        'server': ('testserver', 8088)}, receive, send)
        return messages

    messages = asyncio.run(run())
    status = next(m['status'] for m in messages if m['type'] == 'http.response.start')
    data = b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body')
    return status, (json.loads(data) if data else None)


class MemoryEmbeddingTest(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)
        os.environ['AUTH_MODE'] = 'off'
        main.app.middleware_stack = None
        # test_fleet_auth replaces these on main; put the real ones back.
        main.write_memory, main.search_memories = memory.write_memory, memory.search_memories
        main.context_queue.clear()
        self.qdrant = FakeQdrant()
        self._get_client = memory.get_client
        memory.get_client = lambda: self.qdrant

    def tearDown(self):
        memory.get_client = self._get_client
        main.context_queue.clear()
        os.environ.clear()
        os.environ.update(self._env)
        main.app.middleware_stack = None

    def assert_unavailable(self, status, body):
        self.assertEqual(status, 503, body)
        self.assertIn('embedding unavailable', body['detail'])

    def test_ollama_outage_refuses_the_write_and_writes_nothing(self):
        with ollama_down():
            status, body = call('POST', '/memory/write', {'text': 'remember this', 'source_agent': 'hermes-eve-v'})
        self.assert_unavailable(status, body)
        self.assertEqual(self.qdrant.upserts, [])

    def test_wrong_dimension_or_malformed_vectors_are_refused(self):
        for bad in ([0.1] * 10, [], ['x'] * memory.VECTOR_SIZE, [math.nan] * memory.VECTOR_SIZE, [True] * memory.VECTOR_SIZE,
                    None, 'vector'):
            with self.subTest(bad=str(bad)[:30]), ollama_returns({'embedding': bad}):
                self.assert_unavailable(*call('POST', '/memory/write', {'text': 't'}))
        with ollama_returns({'error': 'model not found'}):
            self.assert_unavailable(*call('POST', '/memory/write', {'text': 't'}))
        self.assertEqual(self.qdrant.upserts, [])

    def test_search_during_an_outage_is_refused_and_never_queries_qdrant(self):
        with ollama_down():
            self.assert_unavailable(*call('POST', '/memory/search', {'query': 'q'}))
            self.assert_unavailable(*call('GET', '/knowledge/search?q=q'))
        self.assertEqual(self.qdrant.queries, [])

    def test_context_forward_during_an_outage_queues_nothing(self):
        with ollama_down():
            status, body = call('POST', '/context/forward', {'from_agent': 'x', 'to_agent': AGENT, 'message': 'm', 'relevant_memories': []})
        self.assert_unavailable(status, body)
        self.assertEqual(main.context_queue, {})
        self.assertEqual(self.qdrant.upserts, [])

    def test_new_points_record_the_embedding_model_and_dimension(self):
        with ollama_returns({'embedding': GOOD}):
            status, body = call('POST', '/memory/write', {'text': 't', 'source_agent': 'a'})
        self.assertEqual(status, 200)
        [point] = self.qdrant.upserts
        self.assertEqual(point.vector, GOOD)
        self.assertEqual(point.payload['embed_model'], memory.EMBED_MODEL)
        self.assertEqual(point.payload['embed_dim'], memory.VECTOR_SIZE)

    def test_search_only_matches_points_of_the_current_model(self):
        with ollama_returns({'embedding': GOOD}):
            status, body = call('POST', '/memory/search', {'query': 'q', 'source_agent': 'a'})
        self.assertEqual((status, body['count']), (200, 1))
        [q] = self.qdrant.queries
        self.assertEqual(q['query'], GOOD)
        conditions = {c.key: c.match for c in q['filter'].must}
        self.assertEqual(conditions['embed_model'].value, memory.EMBED_MODEL)
        self.assertIn('source_agent', conditions)


if __name__ == '__main__':
    unittest.main()
