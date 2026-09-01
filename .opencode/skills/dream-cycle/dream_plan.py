#!/usr/bin/env python3
"""dream_architect_run — Golf-6: beoordeel de 4 open dromen als architect.

Voert de droomcyclus fase-architect handmatig uit (de agent-file is de
spec; dit script materialiseert de plannen). Per proposal → verdict
GO/HOLD/REJECT met capability-matrix en goals; high-risk => requires_human.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/djimit/.hermes/scripts")
from authority_ledger import AuthorityLedger  # noqa: E402

DREAM_STATE = Path.home() / ".hermes" / "state" / "dream"
PLANS = DREAM_STATE / "plans"

# Handmatige architect-review van de 4 W36-proposals (capability-matrix-
# beoordeling aan de hand van de echte ecosystem-structuur).

VERDICTS = {
    "2026-W36-arxiv:2608.28532v1": {
        # xTRUCE — multi-xApp conflict arbiter
        "verdict": "HOLD",
        "reason": (
            "Conflict-mitigation-arbiter is conceptueel verwant aan de "
            "AIMD-concurrency in LoopDaemon, maar xApps zijn radio-domain; "
            "de transitie naar de Djimit-governance vereist een "
            "eigenformulering. Kennisbasis-verrijking wel zinvol."
        ),
        "openmythos_case": "governance:guard:blocked",
        "requires_human": False,
        "goals": [
            {
                "id": "dream-xtruce-1",
                "objective": (
                    "Verwerk xTRUCE-arbiter-concept in de "
                    "ecosystem-kennisbasis (Qdrant dennis-knowledge) en "
                    "leer het aan de dream-agents als referentiepatroon "
                    "voor conflict-mitigatie."
                ),
                "acceptance_criteria": [
                    "knowledge-chunk over xTRUCE opgeslagen in Qdrant",
                    "Djimit2-weekanalyse noemt het concept",
                ],
                "claimed_files": [],
                "risk_class": "low",
                "requires_human": False,
            }
        ],
    },
    "2026-W36-arxiv:2608.28542v1": {
        # Offline-verifiable accountability — direct relevant!
        "verdict": "GO",
        "reason": (
            "Cross-organisation accountability is precies wat de "
            "authority_events-tabel en Paperclip-spillover al doen; de "
            "paper biedt prescriptie voor off-line verificatie die we "
            "kunnen adopteren voor de ledger-digest-keten."
        ),
        "openmythos_case": "authority:ledger:verify",
        "requires_human": False,
        "goals": [
            {
                "id": "dream-account-1",
                "objective": (
                    "Voeg een payload-hash-keten toe aan authority_events: "
                    "elk event verwijst via causation_id naar de digest van "
                    "het vorige event in dezelfde correlation-reeks, zodat "
                    "de keten offline verifieerbaar is."
                ),
                "acceptance_criteria": [
                    "causation_id gevuld op nieuwe events",
                    "verify-script valideert de keten per correlation",
                    "test dekt tampering-detectie",
                ],
                "claimed_files": [
                    "tools/authority_ledger.py (EVE-V)",
                    "packages/mcp-server/src/tools/authority.ts (trace)",
                ],
                "risk_class": "medium",
                "requires_human": False,
            }
        ],
    },
    "2026-W36-arxiv:2608.28553v1": {
        # Logos — cross-process agent harness
        "verdict": "HOLD",
        "reason": (
            "Cross-process bus-harness heeft potentie voor Hermes/OpenClaw-"
            "koppeling, maar de Djimit-architectuur heeft al een IPC-pad "
            "(MCP + authority_events). Eerst de paper verdiepen; "
            "architectuurbesluit nodig van Dennis."
        ),
        "openmythos_case": None,
        "requires_human": True,
        "goals": [],
    },
    "2026-W36-arxiv:2608.28578v1": {
        # Aero Hand — robotics, out-of-scope voor de content-pijplijn
        "verdict": "REJECT",
        "reason": (
            "Dexterous-hand-simulatie raakt geen van de ecosystem-"
            "capabilities (geen content-, governance- of agent-pad). "
            "Geen fit; gesloten met reden."
        ),
        "openmythos_case": None,
        "goals": [],
    },
}


def main() -> int:
    plans_dir = DREAM_STATE / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    ledger = AuthorityLedger()
    emitted = []
    for slug, verdict in VERDICTS.items():
        plan_path = plans_dir / f"{slug}.plan.json"
        plan = {
            "plan_id": slug,
            "verdict": verdict["verdict"],
            "reason": verdict["reason"],
            "openmythos_case": verdict.get("openmythos_case"),
            "requires_human": verdict.get("requires_human", False),
            "goals": verdict.get("goals", []),
            "architect": "dream-architect",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        plan_path = plans_dir / f"{slug}.plan.json"
        plan_path.write_text(json.dumps(plan, indent=2, ensure_ascii=False))

        # emit plan-decision als LifecycleEvent
        cand = {
            "candidate_id": f"dream-plan-{slug.rsplit(':', 1)[-1]}",
            "topic": "dream-plan",
            "title": f"Dream plan {verdict['verdict']}: {slug}",
            "editorial_decision": verdict["verdict"].lower(),
            "kpi": {},
            "state_history": [
                {
                    "from_state": "editorial_review",
                    "to_state": "accepted",
                    "timestamp": plan["created_at"],
                    "actor": "dream-architect",
                    "reason": verdict["reason"][:200],
                    "metadata": {"plan": str(plan_path)},
                }
            ],
        }
        try:
            events = ledger.record_candidate(cand)
            emitted.append(
                {
                    "slug": slug,
                    "verdict": verdict["verdict"],
                    "events": len(events),
                    "plan": str(plan_path),
                }
            )
        except Exception as exc:
            emitted.append({"slug": slug, "error": str(exc)})

        # REJECT -> noteer in de proposal-file zelf
        if verdict["verdict"] == "REJECT":
            proposal = DREAM_STATE / "proposals" / f"{slug}.json"
            if proposal.exists():
                try:
                    pdata = json.loads(proposal.read_text())
                    pdata["closed_by_plan"] = str(plan_path)
                    pdata["closed_reason"] = verdict["reason"]
                    proposal.write_text(json.dumps(pdata, indent=2, ensure_ascii=False))
                except Exception:
                    pass

    print(json.dumps({"plans": emitted}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
