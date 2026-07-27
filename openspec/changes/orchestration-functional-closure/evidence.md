# Evidence

## Deterministic functional benchmark

Command:

```bash
npm run benchmark:self
```

Required assertions:

- evidence-free Judge output is score 0 and unverifiable;
- ExpertSwarm performs exactly two adapter calls across one initial and one fallback attempt;
- at least three parent/child trace edges are stored;
- a stale lease is persisted as cancelled before SelfHealing reports success.

## Test gates

- Functional benchmark: 3/3 passed in three consecutive runs.
- Targeted orchestration, SelfHealing, MetaOrchestration, and OpenMythos tests: 97 passed, 13 intentionally skipped.
- Full repository tests: 1,778 passed, 19 intentionally skipped.
- Lint: passed for every workspace.
- Type-check: passed for every workspace.
- Build: passed for server, dashboard, shared packages, MCP, Telegram, agent catalog, and ransomware module.
- `git diff --check`: passed.
