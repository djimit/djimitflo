from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from bus import EventBus

app = FastAPI(title="Event Bus")
bus = EventBus()

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

@app.get("/events/{stream}")
def read(stream: str, count: int = 10):
    events = bus.read(stream, count)
    return {"stream": stream, "events": events}

@app.get("/streams")
def list_streams():
    streams = bus.list_streams()
    return {"streams": streams}

@app.post("/streams/{stream}/groups")
def create_group(stream: str, group: str):
    created = bus.create_consumer_group(stream, group)
    return {"stream": stream, "group": group, "created": created}
