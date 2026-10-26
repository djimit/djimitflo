from bus import EventBus

STREAMS = [
    "agent:heartbeat",
    "agent:message",
    "agent:task:complete",
    "agent:task:failed",
    "agent:alert",
    "telegram:update",
    "memory:new",
    "skill:evolved",
    "research:complete",
    "mesh:topology_change",
]

def seed():
    bus = EventBus()
    for stream in STREAMS:
        bus.publish(stream, {"event": "stream_initialized", "seed": True})
        print(f"Seeded: {stream}")
    print(f"\nTotal streams: {len(STREAMS)}")

if __name__ == "__main__":
    seed()
