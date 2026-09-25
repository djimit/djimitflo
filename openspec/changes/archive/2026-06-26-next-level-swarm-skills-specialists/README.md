# Next-Level Swarm Skills Specialists

This OpenSpec change models the next Djimitflo scale layer after the real worker bridge and policy-gated worker pool runner.

The core rule is operational truth:

- registry agents are inventory
- goals are intent
- backlog is candidate work
- prepared leases are planned execution
- running leases require runtime evidence
- completed work requires maker/checker evidence and deterministic gates

Run validation:

```bash
openspec validate next-level-swarm-skills-specialists --strict
node --check openspec/changes/next-level-swarm-skills-specialists/run-goals-batch.mjs
node openspec/changes/next-level-swarm-skills-specialists/run-goals-batch.mjs --dry-run
```
