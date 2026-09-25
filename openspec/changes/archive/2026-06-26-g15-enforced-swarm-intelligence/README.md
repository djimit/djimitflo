# G15 Enforced Swarm Intelligence

This change is the build order for turning G14's advisory swarm intelligence into enforced runtime behavior.

Primary command checks:

```sh
openspec validate g15-enforced-swarm-intelligence --strict
node --check openspec/changes/g15-enforced-swarm-intelligence/run-goals-batch.mjs
node openspec/changes/g15-enforced-swarm-intelligence/run-goals-batch.mjs --dry-run
```

The batch registers goals only. It does not spawn workers, start loops, promote memory, merge, push or deploy.
