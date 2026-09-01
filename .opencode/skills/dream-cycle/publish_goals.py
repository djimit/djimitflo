#!/usr/bin/env python3
"""dream_publish (Golf-9c) — post GO-plans als LoopDaemon-goals.

Post alle GO-plans die de authority-ledger al heeft afgehandeld naar de
dream-implementer. Elke goal-emit is een LifecycleEvent (actor
dream-implementer, requested_state PLAN_APPROVED).
"""

from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/djimit/.hermes/scripts")

from authority_ledger import AuthorityLedger  # noqa: E402

DREAM_STATE = Path.home() / ".hermes" / "state" / "dream"
PLANS = DREAM_STATE / "plans"


def main() -> int:
    if not PLANS.exists():
        print(json.dumps({"error": "geen plans"}))
        return 0

    ledger = AuthorityLedger()
    published = []
    for plan_file in sorted(PLANS.glob("*.plan.json")):
        plan = json.loads(plan_file.read_text())

        # alleen GO-plans, skip REJECT / HOLD
        if plan.get("verdict") != "GO":
            continue
        # sla over als dit al gedaan is (geen duplicate emit)
        gid = plan.get("gid") or plan.get("plan_id") or "?"
        already = [
            e
            for e in ledger._scan_all()
            if e.get("correlation_id") == gid
            and e.get("actor", {}).get("subject") == "dream-implementer"
        ]
        if already:
            continue

        # emit PLAN_APPROVED event
        cand = {
            "candidate_id": "dream-plan-" + gid,
            "topic": "dream-implementer",
            "title": "Goal published: " + gid,
            "editorial_decision": "published",
            "kpi": {},
            "state_history": [
                {
                    "from_state": "editorial_review",
                    "to_state": "accepted",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "actor": "dream-implementer",
                    "reason": "Plan gepubliceerd als goal voor LoopDaemon",
                    "metadata": {
                        "plan_file": str(plan_file),
                        "objective": plan.get("objective", "")[:200],
                    },
                }
            ],
        }
        events = ledger.record_candidate(cand)
        published.append({"goal": gid, "events": len(events)})

    print(
        json.dumps(
            {
                "published": len(published),
                "results": published,
                "note": "goals zijn in authority_events geregistreerd; "
                "de LoopDaemon (op VPS) pakt goals op als maker/checker-work "
                "door de goal-API in djimitflo via dashboard of MCP.",
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
