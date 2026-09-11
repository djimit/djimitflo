# G88 — intermittent full-workspace integration-spine result

The first full workspace run after G86 produced one server failure in `integration-spine-service.test.ts`: the preview request returned HTML, so JSON parsing failed, while a concurrent `fatal: not a git repository` diagnostic was emitted. The same file passed in isolation (8/8), the complete server suite passed (2429/20 skipped), and a second complete workspace run passed **2716/20 skipped**.

This is retained as an intermittent harness/runtime observation, not reclassified as fixed. No product behavior was changed for it because no deterministic reproduction or causal owner was established.
