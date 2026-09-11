# G278 swarm-orchestration route proof

Focused HTTP/SQLite fixture: session creation persists a three-subtask plan, list/progress reflect `0/3`, and execution returns typed 503 `SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED` rather than false success. Durable agent message send → receive lease → acknowledge updates state; the same idempotency key replays the original message ID, and communication stats reflect one delivered/read message. No provider or external runtime was started.
