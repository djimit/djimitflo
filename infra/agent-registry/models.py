from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class DapsAssignment(BaseModel):
    id: str
    version: str
    hash: str
    assurance_level: str
    mode: str = "shadow"


class Agent(BaseModel):
    name: str
    bot_name: str
    host: str
    runtime: str
    version: str
    framework: str
    capabilities: list[str]
    mcp_servers: list[str] = []
    sub_agents: list[str] = []
    plugins: list[str] = []
    skills: list[str] = []
    personalities: list[str] = []
    quick_commands: list[str] = []
    auxiliary_models: list[str] = []
    llm_providers: list[str] = []
    api_endpoint: Optional[str] = None
    approval: str = "auto"
    language: str = "en"
    status: str = "online"
    last_heartbeat: Optional[datetime] = None
    liveness_scope: str = "service"
    daps: list[DapsAssignment] = []


class HeartbeatRequest(BaseModel):
    status: str = "online"


class HealthResponse(BaseModel):
    status: str
    agents_count: int
    timestamp: datetime
    registry_generation: Optional[str] = None
    registry_snapshot_hash: Optional[str] = None
    registry_error: Optional[str] = None
    daps_mode: Optional[str] = None


class TopologyResponse(BaseModel):
    agents: list[Agent]
    connections: list[dict]


class CompatWarning(BaseModel):
    agent: str
    framework: str
    version: str
    latest_known: str
    drift_severity: str
