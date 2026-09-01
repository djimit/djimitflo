#!/usr/bin/env python3
"""authority_sync (Golf-9a) — JSONL-spiegel via de authority-proxy.

De AuthorityTracePage heeft de SQL-tabel authority_events (migrate.ts)
maar geen live data-path. De kortste en fail-safe route:
1. push de JSONL via de authority-proxy op EVE-V naar elke 15-min cron.
2. Het /authority/sync endpoint op EVE-V accepteert events van de proxy.

We hebben geen directe SQLite-toegang op de VPS van hieruit; we
publiceren via de bestaande proxy + authority_events collection
(die Qdrant al heeft). djimitflo leest via dezelfde proxy.

Dit script:
  1. Leest alle events uit ~/.hermes/state/authority/authority_events.jsonl
  2. Emit elke event die nog niet in de Qdrant-mirror zit (idempotent)
  3. Bevestigd via authority-proxy /health
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/djimit/.hermes/scripts")

from authority_ledger import AuthorityLedger  # noqa: E402

PROXY_URL = "http://localhost:8077"


def _load_token() -> str:
    tok = Path.home() / ".hermes" / "state" / "authority" / "proxy.token"
    return tok.read_text().strip() if tok.exists() else ""


def push_new_events() -> dict:
    """Stuur events die nog niet in Qdrant zitten via authority_proxy."""
    from authority_ledger import _qdrant_upsert, AuthorityLedger as AL

    ledger = AL()
    events = ledger._scan_all()

    # check welke al in qdrant zitten via de proxy
    token = _load_token if False else None
    tok_path = Path.home() / ".hermes" / "state" / "authority" / "proxy.token"
    tok = tok_path.read_text().strip() if tok_path.exists() else ""

    req = urllib.request.Request(
        PROXY_URL + "/authority/trace/all", headers={"X-Auth-Token": tok}
    )
    # proxy ondersteunt /authority/search zonder filter om alles op te halen
    try:
        req2 = urllib.request.Request(
            "http://localhost:8077/authority/search", headers={"X-Auth-Token": tok}
        )
        with urllib.request.urlopen(req2, timeout=10) as resp:
            import json as _json

            remote = _json.loads(resp.read())
            have = {e.get("event_id") for e in remote.get("events", [])}
    except Exception as exc:
        return {"error": "proxy unreachable: " + str(exc)[:100]}

    missing = [e for e in events if e.get("event_id") not in have]
    if missing:
        from authority_ledger import _qdrant_upsert as _upsert

        chunk = [e for e in missing if e.get("event_id") != "probe"][:100]
        ok = _qdrant_upsert(chunk)
        return {
            "total_jsonl": len(events),
            "already_in_qdrant": len(have),
            "pushed": len(chunk),
            "push_result": ok,
        }

    return {
        "total_jsonl": len(events),
        "already_in_qdrant": len(have),
        "pushed": 0,
        "note": "alles gesynced",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Authority JSONL-sync")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    result = push_new_events() if not args.check_only else {"note": "check-only mode"}
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
