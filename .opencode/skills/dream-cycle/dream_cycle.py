#!/usr/bin/env python3
"""dream_cycle — de droomcyclus van het Djimit-ecosysteem (Golf-5b).

Fasen (elk met een eigen agent: .opencode/agent/dream-*.md):

  scout      : dream-scout verzamelt externe signalen (arXiv, releases,
               publikaties) en schrijft proposals.
  architect  : dream-architect beoordeelt proposals en maakt governed
               goal-plannen (capability-aware, human-approval bij risk).
  implement  : dream-implementer voert approved plans uit als
               LoopDaemon-goals (maker/checker, evidence-geladen).

Elke faseovergang is een LifecycleEvent (actor dream-<fase>). Alle
bronnen fail-open: een dode feed stopt de cyclus niet.

CLI:
    python3 dream_cycle.py --phase scout
    python3 dream_cycle.py --phase architect
    python3 dream_cycle.py --phase status
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import xml.etree.ElementTree as ET  # nosec B405 - alleen Atom-feed
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from authority_ledger import AuthorityLedger  # noqa: E402

DREAM_STATE = Path.home() / ".hermes" / "state" / "dream"
PROPOSALS = DREAM_STATE / "proposals"
PLANS = DREAM_STATE / "plans"
SEEN = DREAM_STATE / "scout-seen.json"

VOCAB = [
    "agent",
    "capability",
    "governance",
    "prompt injection",
    "memory",
    "evaluation",
    "self-improvement",
    "benchmark",
    "tool use",
]


def _ensure_dirs() -> None:
    for d in (DREAM_STATE, PROPOSALS, PLANS):
        d.mkdir(parents=True, exist_ok=True)


def _load_seen() -> dict:
    if SEEN.exists():
        try:
            return json.loads(SEEN.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _fetch_arxiv() -> list[dict]:
    """arXiv Atom-API (geen key). Sorteert op nieuwste, filtert op vocab."""
    query = " OR ".join(f'all:"{w}"' for w in VOCAB[:6])
    url = (
        "http://export.arxiv.org/api/query?"
        f"search_query={urllib.parse.quote(query)}"
        "&sortBy=submittedDate&sortOrder=descending&max_results=20"
    )
    try:
        import urllib.request

        with urllib.request.urlopen(url, timeout=15) as resp:
            tree = ET.fromstring(resp.read())
    except Exception as exc:
        print(f"[dream-cycle] arxiv unreachable: {exc}", file=sys.stderr)
        return []

    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for entry in tree.findall("a:entry", ns):
        title_el = entry.find("a:title", ns)
        id_el = entry.find("a:id", ns)
        summary_el = entry.find("a:summary", ns)
        title = (title_el.text if title_el is not None else "").strip()
        entry_url = (id_el.text if id_el is not None else "").strip()
        out.append(
            {
                "title": title,
                "url": entry_url,
                "summary": (summary_el.text if summary_el is not None else "")[:400],
                "source": "arxiv",
                "seen": f"arxiv:{entry_url.rsplit('/', 1)[-1]}",
            }
        )
    return out


def _score_items(items: list[dict], seen: dict) -> list[dict]:
    scored = []
    for item in items:
        seen_key = item.get("seen") or item.get("url")
        if seen_key and seen.get(seen_key):
            continue
        text = (item.get("title", "") + " " + item.get("summary", "")).lower()
        vocab_hits = sum(1 for w in VOCAB if w in text)
        if vocab_hits == 0:
            continue
        item["scores"] = {
            "novelty": 4,
            "fit": min(5, vocab_hits),
            "implementable": 3,
            "evidence": 4 if item.get("source") == "arxiv" else 3,
        }
        item["scores"]["total"] = sum(item["scores"].values())
        item["proposed_change"] = (
            f"Evalueer '{item['title'][:80]}' voor de ecosystem-kennisbasis "
            "en als governance-verbetering."
        )
        item["targets"] = ["djimitflo", "eve-v-content"]
        scored.append(item)
    scored.sort(key=lambda x: -x["scores"]["total"])
    return scored[:5]  # top-5


def _phase_scout(days: int, dry_run: bool) -> dict:
    _ensure_dirs()
    seen = _load_seen()
    items = _fetch_arxiv()
    scored = _score_items(items, seen)
    week = datetime.now(timezone.utc).strftime("%G-W%V")
    signals_file = DREAM_STATE / f"signals-{week}.json"
    signals_file.write_text(
        json.dumps(
            {"scored": scored, "count": len(scored)}, indent=2, ensure_ascii=False
        )
    )

    created = []
    if not dry_run:
        ledger = AuthorityLedger()
        seen_now = dict(seen)
        for item in scored:
            slug = (item.get("seen") or item.get("url", "x")).rsplit("/", 1)[-1][:40]
            prop_path = PROPOSALS / f"{week}-{slug}.json"
            prop_path.write_text(json.dumps(item, indent=2, ensure_ascii=False))
            seen_now[item.get("seen") or item.get("url")] = True
            cand = {
                "candidate_id": f"dream-{abs(hash(item.get('url'))) % 10**10}",
                "topic": "dream-signal",
                "title": item.get("title", "")[:200],
                "editorial_decision": None,
                "kpi": {},
                "state_history": [
                    {
                        "from_state": "discovered_start",
                        "to_state": "discovered",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "actor": "dream-scout",
                        "reason": "dream-cycle signal (arxiv)",
                        "metadata": {"source": item.get("url")},
                    }
                ],
            }
            ledger.record_candidate(cand)
            created.append({"slug": slug, "proposal": str(prop_path)})
        _save_seen(seen_now)
        created = [p["proposal"] for p in created] if False else created

    return {
        "phase": "scout",
        "week": week,
        "scored_top": len(scored),
        "proposals_created": created,
        "dry_run": dry_run,
    }


def _phase_architect(days: int) -> dict:
    _ensure_dirs()
    open_props = sorted(PROPOSALS.glob("*.json"))
    plans = {p.stem for p in PLANS.glob("*.json")}
    open_items = []
    for p in open_props:
        if p.stem in plans:
            continue
        open_items.append(json.loads(p.read_text()))
    return {
        "phase": "architect",
        "open_proposals": open_items,
        "count": len(open_items),
        "note": (
            "dream-architect (agent) beoordeelt en plannet; "
            "dream-implementer voert uit als goals"
        ),
    }


def _phase_status() -> dict:
    _ensure_dirs()
    ledger = AuthorityLedger()
    dream_evs = [
        e
        for e in ledger._scan_all()
        if e.get("actor", {}).get("subject", "").startswith("dream-")
    ]
    by_actor = Counter(e["actor"]["subject"] for e in dream_evs)
    return {
        "phase": "status",
        "dream_events": len(dream_evs),
        "by_actor": dict(by_actor),
        "proposals_open": len(
            [p for p in PROPOSALS.glob("*.json") if p.stem]
            and [p for p in PROPOSALS.glob("*.json")]
        ),
        "plans": len(list(PLANS.glob("*.json"))),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Djimit Dream Cycle")
    parser.add_argument(
        "--phase", default="status", choices=["scout", "architect", "status"]
    )
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    _ensure_dirs()

    if args.phase == "scout":
        try:
            result = _phase_scout(args.days, args.dry_run)
        except Exception as exc:
            result = {"phase": "scout", "error": str(exc)}
    elif args.phase == "architect":
        result = _phase_architect(args.days)
    else:
        result = _phase_status()

    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
