import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from bus import EventBus
from fleet_auth import FleetAuth, WRITE_METHODS

app = FastAPI(title="Event Bus")
bus = EventBus()


def protected(method: str, path: str):
    """S3: every write (publish, consumer groups) needs a fleet host token; reads stay open in this step."""
    return "write" if method in WRITE_METHODS else None


app.add_middleware(FleetAuth, service="event-bus", protected=protected)

class EventPayload(BaseModel):
    data: dict

@app.get("/health")
def health():
    try:
        bus.r.ping()
        return {"status": "ok", "redis": "connected"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

@app.post("/events/{stream}")
def publish(stream: str, payload: dict):
    msg_id = bus.publish(stream, payload)
    return {"stream": stream, "id": msg_id}

# Reads are open: clamp instead of rejecting, so a reader asking for more (the ingest cursor grows in 5000 steps) still
# gets the newest MAX_READ_COUNT entries rather than a 422, and ?count=100000000 cannot exhaust the container.
MAX_READ_COUNT = int(os.getenv("MAX_READ_COUNT", "50000"))


@app.get("/events/{stream}")
def read(stream: str, count: int = 10):
    events = bus.read(stream, max(1, min(count, MAX_READ_COUNT)))
    return {"stream": stream, "events": events}

@app.get("/streams")
def list_streams():
    streams = bus.list_streams()
    return {"streams": streams}

@app.post("/streams/{stream}/groups")
def create_group(stream: str, group: str):
    created = bus.create_consumer_group(stream, group)
    return {"stream": stream, "group": group, "created": created}
