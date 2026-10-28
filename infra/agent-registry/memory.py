import json
import math
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, VectorParams, Distance, Filter, FieldCondition, MatchText, MatchValue

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


class EmbeddingUnavailable(Exception):
    """STATE-NEW-03: no semantic vector for this text. Callers refuse (HTTP 503); there is no lexical stand-in in this collection."""


def _embed(text: str) -> list[float]:
    """The Ollama embedding, or EmbeddingUnavailable. Anything but VECTOR_SIZE finite numbers is refused."""
    try:
        vec = _embed_ollama(text)
    except Exception as e:
        raise EmbeddingUnavailable(f"embedding unavailable: {EMBED_MODEL} call failed ({type(e).__name__})") from e
    if not isinstance(vec, list) or len(vec) != VECTOR_SIZE:
        got = len(vec) if isinstance(vec, list) else type(vec).__name__
        raise EmbeddingUnavailable(f"embedding unavailable: {EMBED_MODEL} returned {got}, expected {VECTOR_SIZE} values")
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in vec):
        raise EmbeddingUnavailable(f"embedding unavailable: {EMBED_MODEL} returned non-numeric or non-finite values")
    return vec


def write_memory(text: str, source_agent: str, metadata: Optional[dict] = None) -> dict:
    vector = _embed(text)
    client = get_client()
    ensure_collection(client)
    point_id = str(uuid.uuid4())
    payload = {
        "text": text,
        "source_agent": source_agent,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "embed_model": EMBED_MODEL,
        "embed_dim": VECTOR_SIZE,
    }
    if metadata:
        payload["metadata"] = metadata
    client.upsert(
        collection_name=COLLECTION,
        points=[PointStruct(id=point_id, vector=vector, payload=payload)],
    )
    return {"id": point_id, **payload}


def search_memories(query: str, source_agent: Optional[str] = None, limit: int = 10) -> list[dict]:
    vector = _embed(query)
    client = get_client()
    ensure_collection(client)
    # Only points embedded by the current model; older points without embed_model are "unknown" and stay out of the search.
    must = [FieldCondition(key="embed_model", match=MatchValue(value=EMBED_MODEL))]
    if source_agent:
        must.append(FieldCondition(key="source_agent", match=MatchText(text=source_agent)))
    results = client.query_points(
        collection_name=COLLECTION,
        query=vector,
        query_filter=Filter(must=must),
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
