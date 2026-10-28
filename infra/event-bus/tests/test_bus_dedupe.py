"""STATE-NEW-02: publishing the same event (same dedupe_key) twice appends it once and returns the same entry id.

The fake Redis below mirrors the dedupe script's semantics so the HTTP route and the bus can be tested offline. The script
itself runs against a real Redis in RealRedisDedupeTest when REDIS_TEST_URL is set (CI provides one).
"""
import asyncio
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('REDIS_PASSWORD', 'test-only')

import bus  # noqa: E402
import main  # noqa: E402


class FakeRedis:
    """Streams + string keys. `eval` interprets the dedupe script: KEYS = (stream, dedupe key), ARGV = (ttl, field, value, ...)."""

    def __init__(self):
        self.streams, self.keys, self.ttls, self.seq = {}, {}, {}, 0

    def xadd(self, stream, fields):
        self.seq += 1
        entry_id = f'{self.seq}-0'
        self.streams.setdefault(stream, []).append((entry_id, dict(fields)))
        return entry_id

    def eval(self, script, numkeys, *args):
        (stream, dedupe_key), argv = args[:numkeys], args[numkeys:]
        if dedupe_key in self.keys:
            return self.keys[dedupe_key]
        fields = dict(zip(argv[1::2], argv[2::2]))
        entry_id = self.xadd(stream, fields)
        self.keys[dedupe_key], self.ttls[dedupe_key] = entry_id, int(argv[0])
        return entry_id


def make_bus(client):
    b = bus.EventBus.__new__(bus.EventBus)
    b.r = client
    return b


def post(path, body):
    raw = json.dumps(body).encode()

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

        headers = {'host': '100.86.47.122:8083', 'content-type': 'application/json'}
        await main.app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST', 'scheme': 'http',
                        'path': path, 'raw_path': path.encode(), 'query_string': b'', 'root_path': '',
                        'headers': [(k.encode(), v.encode()) for k, v in headers.items()], 'client': ('100.101.220.31', 50000),
                        'server': ('testserver', 8000)}, receive, send)
        return messages

    messages = asyncio.run(run())
    status = next(m['status'] for m in messages if m['type'] == 'http.response.start')
    return status, json.loads(b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body'))


EVENT = {'event_id': 'djimitflo:e1', 'event_type': 'djimitflo.work_item.created', 'source': 'djimitflo',
         'dedupe_key': 'djimitflo:e1', 'payload': {'title': 't', 'labels': ['a']}, 'attempt': 1}


class BusDedupeTest(unittest.TestCase):
    def setUp(self):
        self.redis = FakeRedis()
        self.bus = make_bus(self.redis)

    def test_same_dedupe_key_twice_appends_once_and_returns_the_first_id(self):
        first = self.bus.publish('djimit.events', EVENT)
        second = self.bus.publish('djimit.events', {**EVENT, 'attempt': 2})  # a retry after a lost ack
        self.assertEqual(first, second)
        self.assertEqual(len(self.redis.streams['djimit.events']), 1)

    def test_dedupe_window_is_per_stream_and_has_a_ttl(self):
        self.bus.publish('djimit.events', EVENT)
        self.bus.publish('other.stream', EVENT)
        self.assertEqual((len(self.redis.streams['djimit.events']), len(self.redis.streams['other.stream'])), (1, 1))
        self.assertEqual(set(self.redis.ttls.values()), {7 * 24 * 3600})

    def test_stream_and_key_pairs_that_concatenate_alike_do_not_collide(self):
        self.bus.publish('a:b', {**EVENT, 'dedupe_key': 'c'})
        self.bus.publish('a', {**EVENT, 'dedupe_key': 'b:c'})
        self.assertEqual((len(self.redis.streams['a:b']), len(self.redis.streams['a'])), (1, 1))

    def test_dict_and_list_fields_are_still_flattened_to_json(self):  # DJI-724
        self.bus.publish('djimit.events', EVENT)
        _, fields = self.redis.streams['djimit.events'][0]
        self.assertEqual(json.loads(fields['payload']), {'title': 't', 'labels': ['a']})
        self.assertEqual(fields['dedupe_key'], 'djimitflo:e1')

    def test_events_without_dedupe_key_append_every_time(self):
        event = {k: v for k, v in EVENT.items() if k != 'dedupe_key'}
        self.assertNotEqual(self.bus.publish('djimit.events', event), self.bus.publish('djimit.events', event))
        self.assertEqual(len(self.redis.streams['djimit.events']), 2)
        self.assertEqual(self.redis.keys, {})


class PublishRouteDedupeTest(unittest.TestCase):
    def setUp(self):
        self._bus, self._env = main.bus, dict(os.environ)
        self.redis = FakeRedis()
        main.bus = make_bus(self.redis)
        os.environ['AUTH_MODE'] = 'off'
        main.app.middleware_stack = None

    def tearDown(self):
        main.bus = self._bus
        os.environ.clear()
        os.environ.update(self._env)
        main.app.middleware_stack = None

    def test_a_retried_post_gets_the_same_response_and_one_stream_entry(self):
        first = post('/events/djimit.events', EVENT)
        second = post('/events/djimit.events', EVENT)
        self.assertEqual(first, (200, {'stream': 'djimit.events', 'id': '1-0'}))
        self.assertEqual(second, first)
        self.assertEqual(len(self.redis.streams['djimit.events']), 1)


@unittest.skipUnless(os.environ.get('REDIS_TEST_URL'), 'REDIS_TEST_URL not set: dedupe script not run against a real Redis')
class RealRedisDedupeTest(unittest.TestCase):
    def setUp(self):
        import redis
        self.r = redis.Redis.from_url(os.environ['REDIS_TEST_URL'], decode_responses=True)
        self.stream = f'test.dedupe.{os.getpid()}'
        self.before = set(self.r.keys('dedupe:*'))
        self.bus = make_bus(self.r)

    def created_dedupe_keys(self):
        return set(self.r.keys('dedupe:*')) - self.before

    def tearDown(self):  # remove only what this test created
        self.r.delete(self.stream, f'{self.stream}:b', *self.created_dedupe_keys())

    def test_script_appends_once_returns_stable_id_and_sets_ttl(self):
        first = self.bus.publish(self.stream, EVENT)
        second = self.bus.publish(self.stream, EVENT)
        self.assertEqual(first, second)
        entries = self.r.xrange(self.stream)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0][0], first)
        self.assertEqual(json.loads(entries[0][1]['payload']), EVENT['payload'])
        self.assertEqual(entries[0][1]['attempt'], '1')
        [dedupe_key] = self.created_dedupe_keys()
        ttl = self.r.ttl(dedupe_key)
        self.assertTrue(0 < ttl <= 7 * 24 * 3600, ttl)
        self.assertEqual(self.r.get(dedupe_key), first)

    def test_stream_and_key_pairs_that_concatenate_alike_both_get_an_entry(self):
        left, right = f'{self.stream}:b', self.stream
        self.bus.publish(left, {**EVENT, 'dedupe_key': 'c'})  # entry ids are stream-local and may coincide: check lengths
        self.bus.publish(right, {**EVENT, 'dedupe_key': 'b:c'})
        self.assertEqual((self.r.xlen(left), self.r.xlen(right)), (1, 1))

    def test_without_dedupe_key_appends_every_time(self):
        event = {k: v for k, v in EVENT.items() if k != 'dedupe_key'}
        self.bus.publish(self.stream, event)
        self.bus.publish(self.stream, event)
        self.assertEqual(self.r.xlen(self.stream), 2)


if __name__ == '__main__':
    unittest.main()
