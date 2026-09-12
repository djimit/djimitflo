# Swarm broadcast route G352

The swarm orchestration fixture mounts `/api/swarm` and executes the broadcast
chain over SQLite:

- authenticated `agent-a` broadcasts a structured task with evidence;
- the route returns HTTP 201 and persists the broadcast message;
- replaying the same idempotency key returns the same message id;
- a forged `agent-b` sender is rejected with HTTP 403
  (`BOARD_AGENT_PRINCIPAL_INVALID`).
