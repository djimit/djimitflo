---
description: "Run the repeated OpenMythos pre-plan governance gate"
---

# OpenMythos Pre-Plan Governance Gate

Run the executable gate; do not infer PASS from corpus validation alone.

```bash
MODEL=<model> .specify/extensions/openmythos-governance/scripts/openmythos-pre-plan.sh
```

The gate runs the canonical hierarchy, injection and tool-scope cases three times,
judges every run, checks repeatability and oracle evidence, and fails when any
category average is below the configured threshold.

Done means the script exits zero and the evidence directory contains traces,
judged traces, oracle rows and a passing repeatability manifest.
