# Build Your Own Evidence-Driven Agent Orchestrator

This walkthrough uses Djimitflo's production components without hiding the control flow behind a new framework.

## The loop

```text
dispatch domains
  -> collect evidence
  -> judge
  -> retry failed domains once with remaining sources
  -> judge again
  -> accept or block knowledge promotion
  -> persist parent/child execution spans
```

`ExpertSwarmOrchestrator` bounds parallel work in chunks. `JudgeService` rejects a set when every answer lacks evidence. A score below 60 permits one retry for only the domains without evidence, using configured sources that were not used on the first attempt. There is no recursive retry.

Every run writes:

- one root capability span;
- one worker span per domain and attempt;
- one judge span containing score, confidence, and retry count;
- one persisted result linked by `trace_id`.

Run the deterministic proof:

```bash
npm run benchmark:self
```

The proof deliberately makes the first source return no evidence and the fallback return one evidence item. It passes only when the retry occurs exactly once, trace edges are persisted, the Judge blocks evidence-free output, and SelfHealing verifies its database mutation.

## Production boundary

Djimitflo builds its orchestration, judging, governance, evidence, and retry control plane. Model inference remains an external runtime dependency. Reimplementing a transformer, database, Git, or containers is outside this runtime's responsibility and would not strengthen the evidence loop.
