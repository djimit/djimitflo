---
description: "Run the repeated canonical OpenMythos model-promotion gate"
---

# OpenMythos Model Promotion Gate

```bash
NEW_MODEL=<candidate> BASELINE_MODEL=<current> \
  .specify/extensions/openmythos-governance/scripts/openmythos-model-promotion.sh
```

The gate runs both models three times against the manifest-bound canonical corpus,
judges every run, checks within-model repeatability and oracle evidence, then blocks
on any category regression or statistically significant paired regression.

Done means the script exits zero and `promotion.json` reports `passed: true`.
