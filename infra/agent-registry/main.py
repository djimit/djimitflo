from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from datetime import datetime, timezone
from typing import Optional
import json
import os
import re
from pathlib import Path

from models import Agent, HeartbeatRequest, HealthResponse, TopologyResponse, CompatWarning
from seed_data import SEED_AGENTS
from memory import write_memory, search_memories, list_memories, delete_memory, EmbeddingUnavailable
from fleet_auth import FleetAuth, WRITE_METHODS

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

app = FastAPI(title="Agent Registry Service", version="1.1.0")

# Reads that hand out shared-memory contents (or forwarded context) are protected like writes.
MEMORY_READS = re.compile(r"^/(memory/list|knowledge/search|context/receive/[^/]+)/?$")


def protected(method: str, path: str):
    """S3: every write (heartbeat, memory write/search/delete, source register, context forward) needs a fleet host
    token, and so does every read that returns memory contents. Agent/topology/health reads stay open in this step."""
    if method in WRITE_METHODS:
        return "write"
    if method in ("GET", "HEAD") and MEMORY_READS.match(path):
        return "memory_read"
    return None


app.add_middleware(FleetAuth, service="agent-registry", protected=protected)


@app.exception_handler(EmbeddingUnavailable)
def embedding_unavailable(request, exc: EmbeddingUnavailable):
    """STATE-NEW-03: every memory write/search (and the routes built on them) refuses instead of using a non-semantic vector."""
    return JSONResponse(status_code=503, content={"detail": str(exc)})

registry: dict[str, Agent] = {a.name: a for a in SEED_AGENTS}
LIVE_AGENTS_FILE = Path(os.getenv("LIVE_AGENTS_FILE", "/app/registry/live_agents.json"))
REGISTRY_STATE_FILE = Path(os.getenv("REGISTRY_STATE_FILE", "/app/registry/registry_state.json"))
projection_state: dict = {"status": "NOT_LOADED", "generation": None, "snapshot_hash": None, "error": None, "daps_mode": None}

# In-memory context queue for forwarding (ponytail: swap for Redis/pubsub later)
context_queue: dict[str, list[dict]] = {}


def refresh_registry() -> dict:
    global projection_state
    if REGISTRY_STATE_FILE.exists():
        try:
            projection_state = json.loads(REGISTRY_STATE_FILE.read_text())
        except Exception as error:
            projection_state = {**projection_state, "status": "ERROR", "error": f"REGISTRY_STATE_INVALID:{type(error).__name__}"}
    else:
        projection_state = {**projection_state, "status": "ERROR", "error": "REGISTRY_STATE_FILE_MISSING"}
    if not LIVE_AGENTS_FILE.exists():
        projection_state = {**projection_state, "status": "ERROR", "error": "LIVE_AGENTS_FILE_MISSING"}
        return projection_state
    try:
        live_agents = [Agent.model_validate(item) for item in json.loads(LIVE_AGENTS_FILE.read_text())]
    except Exception as error:
        projection_state = {**projection_state, "status": "ERROR", "error": f"LIVE_AGENTS_INVALID:{type(error).__name__}"}
        return projection_state
    if projection_state.get("status") != "VALID":
        for agent in live_agents:
            agent.daps = []
    registry.clear()
    registry.update({agent.name: agent for agent in live_agents})
    return projection_state


# ── Existing endpoints ──────────────────────────────────────────────

@app.get("/health")
def health() -> HealthResponse:
    state = refresh_registry()
    return HealthResponse(
        status="ok" if state.get("status") == "VALID" else "degraded",
        agents_count=len(registry),
        timestamp=datetime.now(timezone.utc),
        registry_generation=state.get("generation"),
        registry_snapshot_hash=state.get("snapshot_hash"),
        registry_error=state.get("error"),
        daps_mode=state.get("daps_mode"),
    )


@app.get("/daps/status")
def daps_status() -> dict:
    return refresh_registry()


@app.get("/agents")
def list_agents() -> list[Agent]:
    refresh_registry()
    return list(registry.values())


@app.get("/agents/{name}")
def get_agent(name: str) -> Agent:
    refresh_registry()
    if name not in registry:
        raise HTTPException(status_code=404, detail=f"Agent {name} not found")
    return registry[name]


@app.post("/agents/{name}/heartbeat")
def heartbeat(name: str, req: HeartbeatRequest) -> Agent:
    refresh_registry()
    if name not in registry:
        raise HTTPException(status_code=404, detail=f"Agent {name} not found")
    agent = registry[name]
    agent.status = req.status
    agent.last_heartbeat = datetime.now(timezone.utc)
    return agent


@app.get("/agents/capabilities/{cap}")
def find_by_capability(cap: str) -> list[Agent]:
    refresh_registry()
    return [a for a in registry.values() if cap.lower() in [c.lower() for c in a.capabilities]]


@app.get("/agents/skills/{skill}")
def find_by_skill(skill: str) -> list[Agent]:
    refresh_registry()
    return [a for a in registry.values() if skill.lower() in [s.lower() for s in a.skills]]


@app.get("/topology")
def topology() -> TopologyResponse:
    refresh_registry()
    connections = []
    agents = list(registry.values())
    hermes_agents = [a for a in agents if a.framework == "hermes"]
    for i, a in enumerate(hermes_agents):
        for b in hermes_agents[i + 1:]:
            connections.append({
                "source": a.name,
                "target": b.name,
                "type": "hermes_mesh",
            })
    for a in agents:
        for mcp in a.mcp_servers:
            connections.append({
                "source": a.name,
                "target": f"mcp:{mcp}",
                "type": "mcp_connection",
            })
    return TopologyResponse(agents=agents, connections=connections)


@app.get("/compat-warnings")
def compat_warnings() -> list[CompatWarning]:
    refresh_registry()
    warnings = []
    hermes_versions: dict[str, list[tuple[str, str]]] = {}
    for a in registry.values():
        if a.framework == "hermes":
            hermes_versions.setdefault(a.version, []).append((a.name, a.version))

    if len(hermes_versions) > 1:
        latest = max(hermes_versions.keys())
        for version, agents in hermes_versions.items():
            if version != latest:
                for agent_name, _ in agents:
                    warnings.append(CompatWarning(
                        agent=agent_name,
                        framework="hermes",
                        version=version,
                        latest_known=latest,
                        drift_severity="medium",
                    ))
    return warnings


@app.get("/agents/{name}/auxiliary-models")
def auxiliary_models(name: str) -> list[str]:
    refresh_registry()
    if name not in registry:
        raise HTTPException(status_code=404, detail=f"Agent {name} not found")
    return registry[name].auxiliary_models


# ── S07: Shared Memory ─────────────────────────────────────────────

@app.post("/memory/write")
def memory_write(body: dict) -> dict:
    text = body.get("text")
    source_agent = body.get("source_agent", "unknown")
    metadata = body.get("metadata")
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    return write_memory(text, source_agent, metadata)


@app.post("/memory/search")
def memory_search(body: dict) -> dict:
    query = body.get("query", "")
    source_agent = body.get("source_agent")
    limit = body.get("limit", 10)
    results = search_memories(query, source_agent, limit)
    return {"results": results, "count": len(results)}


@app.get("/memory/list")
def memory_list(limit: int = 50) -> dict:
    results = list_memories(limit)
    return {"results": results, "count": len(results)}


@app.delete("/memory/{memory_id}")
def memory_delete(memory_id: str) -> dict:
    return delete_memory(memory_id)


# ── S08: Knowledge MCP Bus ─────────────────────────────────────────

KNOWLEDGE_MCP_URL = os.getenv("KNOWLEDGE_MCP_URL", "http://100.77.58.72:8007")

_KNOWLEDGE_SOURCES: dict[str, str] = {
    "knowledge-mcp": KNOWLEDGE_MCP_URL,
    "shared_memory": "internal://agent_shared_memory",
}


@app.get("/knowledge/search")
def knowledge_search(q: str) -> dict:
    results = []
    # Search shared memory
    mem_results = search_memories(q, limit=5)
    for r in mem_results:
        results.append({
            "source": "shared_memory",
            "text": r.get("text", ""),
            "score": r.get("score", 0),
            "source_agent": r.get("source_agent"),
        })
    # Proxy to Knowledge MCP if available
    if HAS_HTTPX:
        try:
            resp = httpx.get(
                f"{KNOWLEDGE_MCP_URL}/search",
                params={"q": q},
                timeout=5.0,
            )
            if resp.status_code == 200:
                kmcp = resp.json()
                for item in kmcp.get("results", kmcp if isinstance(kmcp, list) else []):
                    results.append({
                        "source": "knowledge-mcp",
                        **item,
                    })
        except Exception:
            pass  # ponytail: knowledge MCP unreachable, return what we have
    return {"results": results, "query": q}


@app.get("/knowledge/sources")
def knowledge_sources() -> dict:
    return {"sources": _KNOWLEDGE_SOURCES}


@app.post("/knowledge/agent/{name}/register")
def knowledge_register(name: str, body: dict) -> dict:
    url = body.get("url", "")
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    _KNOWLEDGE_SOURCES[name] = url
    return {"registered": name, "url": url}


# ── S09: Context Forwarding ────────────────────────────────────────

@app.post("/context/forward")
def context_forward(body: dict) -> dict:
    from_agent = body.get("from_agent", "unknown")
    to_agent = body.get("to_agent", "")
    message = body.get("message", "")
    relevant_memories = body.get("relevant_memories")

    if not to_agent:
        raise HTTPException(status_code=400, detail="to_agent is required")

    if to_agent not in registry:
        raise HTTPException(status_code=404, detail=f"Target agent {to_agent} not found")

    # Auto-enrich with relevant memories if not provided
    if relevant_memories is None and message:
        relevant_memories = search_memories(message, limit=3)

    entry = {
        "from_agent": from_agent,
        "to_agent": to_agent,
        "message": message,
        "relevant_memories": relevant_memories or [],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "delivered": False,
    }

    # Store in shared memory for persistence first: if that is refused (503) nothing is queued, so a retry cannot double-queue
    write_memory(
        text=f"Context from {from_agent} to {to_agent}: {message}",
        source_agent=from_agent,
        metadata={"type": "context_forward", "to_agent": to_agent},
    )

    context_queue.setdefault(to_agent, []).append(entry)

    return {"status": "forwarded", "to_agent": to_agent, "queue_depth": len(context_queue[to_agent])}


@app.get("/context/receive/{agent}")
def context_receive(agent: str) -> dict:
    if agent not in registry:
        raise HTTPException(status_code=404, detail=f"Agent {agent} not found")
    pending = context_queue.get(agent, [])
    # Mark as delivered
    for entry in pending:
        entry["delivered"] = True
    return {"agent": agent, "pending": pending, "count": len(pending)}
