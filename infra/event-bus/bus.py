import redis
import json
import os
from typing import Callable

REDIS_PASSWORD = os.environ["REDIS_PASSWORD"]

class EventBus:
    def __init__(self, host=None, port=6379, db=0, password=REDIS_PASSWORD):
        host = host or os.getenv("REDIS_HOST", "redis")
        self.r = redis.Redis(host=host, port=port, db=db, password=password, decode_responses=True)

    def publish(self, stream: str, event: dict) -> str:
        # DJI-724 fix: redis-py xadd rejects non-scalar (dict/list) field values.
        # Flatten them to JSON strings; consumers already decode JSON-string
        # fields back to their original shape (see external-event-ingest-service.ts decodeField()).
        flat_event = {
            k: (v if isinstance(v, (str, bytes, int, float)) and not isinstance(v, bool) else json.dumps(v))
            for k, v in event.items()
        }
        return self.r.xadd(stream, flat_event)

    def read(self, stream: str, count: int = 10) -> list:
        entries = self.r.xrevrange(stream, count=count)
        result = []
        for entry_id, fields in entries:
            fields["_id"] = entry_id
            result.append(fields)
        return result

    def subscribe(self, stream: str, handler: Callable, group="default", consumer="c1"):
        try:
            self.r.xgroup_create(stream, group, id="0", mkstream=True)
        except redis.exceptions.ResponseError:
            pass
        while True:
            entries = self.r.xreadgroup(group, consumer, {stream: ">"}, count=1, block=5000)
            if entries:
                for stream_name, messages in entries:
                    for msg_id, fields in messages:
                        handler(msg_id, fields)
                        self.r.xack(stream, group, msg_id)

    def create_consumer_group(self, stream: str, group: str, id: str = "0") -> bool:
        try:
            self.r.xgroup_create(stream, group, id=id, mkstream=True)
            return True
        except redis.exceptions.ResponseError:
            return False

    def list_streams(self) -> list:
        keys = self.r.keys("*")
        streams = []
        for k in keys:
            try:
                info = self.r.xinfo_stream(k)
                if info.get("length", 0) >= 0:
                    streams.append({"name": k, "length": info["length"]})
            except redis.exceptions.ResponseError:
                continue
        return streams
