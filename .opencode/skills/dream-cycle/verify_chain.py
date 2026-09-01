#!/usr/bin/env python3
"""verify_chain — chain-of-custody per correlation (dream-account-1)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, "/home/djimit/.hermes/scripts")

from authority_ledger import AuthorityLedger  # noqa: E402


def verify_chain(correlation_id: str) -> dict:
    """Valideer de causation-keten per correlation-reeks.

    causation_id[n] moet gelijk zijn aan payload_digest van het event op
    sequence-1. Tampering => verdict tampered + event-id.
    """
    ledger = AuthorityLedger()
    events = [e for e in ledger._scan_all()
              if e.get("correlation_id") == correlation_id]
    if not events:
        return {"verdict": "empty", "correlation_id": correlation_id}

    for i, ev in enumerate(events):
        if i == 0:
            continue
        prev = events[i - 1]
        cid = ev.get("causation_id")
        if cid and cid != prev.get("payload_digest"):
            return {
                "verdict": "tampered",
                "correlation_id": correlation_id,
                "broken_at": ev.get("event_id"),
                "at_sequence": ev.get("sequence"),
            }
    return {
        "verdict": "valid",
        "correlation_id": correlation_id,
        "events": len(events),
        "digest": events[-1].get("payload_digest", "")[:16],
    }


def verify_all() -> dict:
    """Valideer alle reeksen; fail-report per gebroken keten."""
    ledger = AuthorityLedger()
    correlations = {e.get("correlation_id") for e in ledger._scan_all()
                    if e.get("correlation_id")}
    results = {c: verify_chain(c) for c in sorted(correlations)}
    bad = {c: r for c, r in results.items()
           if r["verdict"] in ("tampered", "empty")}
    return {"total_chains": len(correlations), "broken": bad,
            "all_valid": not bad}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--correlation-id", dest="corr")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()
    if args.corr:
        print(json.dumps(verify_chain(args.corr), indent=2))
    else:
        print(json.dumps(verify_all(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
