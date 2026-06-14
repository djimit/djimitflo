#!/usr/bin/env python3
"""
swarm_message_bus.py — Python CLI for the Djimitflo agent message bus

Connects to Redis at localhost:6379, subscribes to swarm.messages.*,
logs all received messages to stdout, and can publish messages from CLI.

Usage:
    python swarm_message_bus.py [agent_name]           # Subscribe and listen
    python swarm_message_bus.py publish \
003cfrom_agent_id> \<to_agent_id> \<type> \<payload_json>

Examples:
    python swarm_message_bus.py worker-1
    python swarm_message_bus.py publish agent-a agent-b task_delegation '{"task_id":"abc"}'
"""

import argparse
import json
import os
import signal
import sys
from datetime import datetime, timezone

import redis

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))
REDIS_DB = int(os.getenv("REDIS_DB", 0))

PATTERN = "swarm.messages.*"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_message(channel: bytes, data: bytes) -> None:
    ts = now_iso()
    try:
        payload = json.loads(data.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = {"raw": data.decode("utf-8", errors="replace")}

    print(
        f"[{ts}] channel={channel.decode('utf-8')} id={payload.get('id', 'N/A')} "
        f"from={payload.get('from_agent_id', 'N/A')} "
        f"to={payload.get('to_agent_id', 'N/A')} "
        f"type={payload.get('type', 'N/A')} "
        f"priority={payload.get('priority', 'N/A')}"
    )
    if "payload" in payload:
        print(f"         body={json.dumps(payload['payload'], ensure_ascii=False)}")
    sys.stdout.flush()


class Listener:
    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        self._redis = redis.Redis(
            host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=False
        )
        self._pubsub = self._redis.pubsub()
        self._running = True

    def run(self) -> None:
        self._pubsub.psubscribe(
            {PATTERN: lambda message: log_message(message["channel"], message["data"])}
        )
        print(
            f"[{now_iso()}] Subscribed to {PATTERN} — listening as '{self.agent_name}'"
        )
        print(f"[{now_iso()}] Redis: {REDIS_HOST}:{REDIS_PORT} (db={REDIS_DB})")
        print("Press Ctrl+C to exit.\n")
        sys.stdout.flush()

        try:
            while self._running:
                self._pubsub.get_message(timeout=1)
        except KeyboardInterrupt:
            pass
        finally:
            self._pubsub.punsubscribe(PATTERN)
            self._pubsub.close()
            self._redis.close()
            print(f"\n[{now_iso()}] Unsubscribed and disconnected.")

    def stop(self, _signum, _frame) -> None:
        self._running = False


def publish_message(
    from_agent_id: str, to_agent_id: str, msg_type: str, payload_json: str
) -> None:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError as exc:
        print(f"Error: payload_json is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(1)

    valid_types = ("task_delegation", "status_update", "knowledge_share", "alert")
    if msg_type not in valid_types:
        print(f"Error: type must be one of {valid_types}", file=sys.stderr)
        sys.exit(1)

    message = {
        "id": f"py-{now_iso()}-{os.urandom(4).hex()}",
        "from_agent_id": from_agent_id,
        "to_agent_id": to_agent_id,
        "type": msg_type,
        "payload": payload,
        "priority": "medium",
        "read_at": None,
        "created_at": now_iso(),
    }

    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
    channel = f"swarm.messages.{to_agent_id}"
    r.publish(channel, json.dumps(message, ensure_ascii=False))
    r.close()
    print(
        f"[{now_iso()}] Published to {channel}: {json.dumps(message, ensure_ascii=False)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Djimitflo Swarm Message Bus CLI")
    subparsers = parser.add_subparsers(dest="command")

    # Default: listen
    listen_parser = subparsers.add_parser(
        "listen", help="Subscribe and listen to messages"
    )
    listen_parser.add_argument(
        "agent_name",
        nargs="?",
        default="python-agent",
        help="Name of this listener agent",
    )

    # Publish command
    pub_parser = subparsers.add_parser("publish", help="Publish a message")
    pub_parser.add_argument("from_agent_id", help="Sender agent ID")
    pub_parser.add_argument("to_agent_id", help="Recipient agent ID")
    pub_parser.add_argument("type", help="Message type")
    pub_parser.add_argument("payload_json", help="JSON payload string")

    args = parser.parse_args()

    if args.command == "publish":
        publish_message(
            args.from_agent_id, args.to_agent_id, args.type, args.payload_json
        )
    else:
        agent_name = (
            args.agent_name
            if args.agent_name
            else (sys.argv[1] if len(sys.argv) > 1 else "python-agent")
        )
        listener = Listener(agent_name)
        signal.signal(signal.SIGINT, listener.stop)
        signal.signal(signal.SIGTERM, listener.stop)
        listener.run()


if __name__ == "__main__":
    main()
