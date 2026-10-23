import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, VectorParams, Distance, Filter, FieldCondition, MatchText

QDRANT_URL = os.environ["QDRANT_URL"]
QDRANT_KEY = os.environ["QDRANT_API_KEY"]
OLLAMA_URL = os.getenv("OLLAMA_URL", "https://ollama.com")
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "")
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
COLLECTION = "agent_shared_memory_v2"
VECTOR_SIZE = 768


def get_client() -> QdrantClient:
    return QdrantClient(url=QDRANT_URL, api_key=QDRANT_KEY)


def ensure_collection(client: QdrantClient) -> None:
    existing = [c.name for c in client.get_collections().collections]
    if COLLECTION not in existing:
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )


def _embed_ollama(text: str) -> list[float]:
    """Real embedding via Ollama nomic-embed-text."""
    resp = httpx.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text[:8000]},
        headers={"Authorization": f"Bearer {OLLAMA_API_KEY}"} if OLLAMA_API_KEY else {},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def _embed_hash(text: str) -> list[float]:
    """Fallback hash-based embedding."""
    vec = [0.0] * VECTOR_SIZE
    words = text.lower().split()
    for w in words:
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        idx = h % VECTOR_SIZE
        vec[idx] += 1.0
    norm = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / norm for x in vec]


def _embed(text: str) -> list[float]:
    """Try Ollama first, fallback to hash."""
    try:
        return _embed_ollama(text)
    except Exception:
        return _embed_hash(text)


def write_memory(text: str, source_agent: str, metadata: Optional[dict] = None) -> dict:
    client = get_client()
    ensure_collection(client)
    point_id = str(uuid.uuid4())
    payload = {
        "text": text,
        "source_agent": source_agent,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if metadata:
        payload["metadata"] = metadata
    client.upsert(
        collection_name=COLLECTION,
        points=[PointStruct(id=point_id, vector=_embed(text), payload=payload)],
    )
    return {"id": point_id, **payload}


def search_memories(query: str, source_agent: Optional[str] = None, limit: int = 10) -> list[dict]:
    client = get_client()
    ensure_collection(client)
    must = []
    if source_agent:
        must.append(FieldCondition(key="source_agent", match=MatchText(text=source_agent)))
    results = client.query_points(
        collection_name=COLLECTION,
        query=_embed(query),
        query_filter=Filter(must=must) if must else None,
        limit=limit,
        with_payload=True,
    )
    return [
        {"id": str(p.id), "score": p.score, **p.payload}
        for p in results.points
    ]


def list_memories(limit: int = 50) -> list[dict]:
    client = get_client()
    ensure_collection(client)
    results = client.scroll(
        collection_name=COLLECTION,
        limit=limit,
        with_payload=True,
        with_vectors=False,
    )
    return [{"id": str(p.id), **p.payload} for p in results[0]]


def delete_memory(memory_id: str) -> dict:
    client = get_client()
    client.delete(
        collection_name=COLLECTION,
        points_selector=[memory_id],
    )
    return {"deleted": memory_id}
