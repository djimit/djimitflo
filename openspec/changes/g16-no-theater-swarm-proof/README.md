# G16 No-Theater Swarm Proof

This change turns the current swarm foundation into a demonstrable proof run.

It is not complete when tests pass. It is complete when the workstation shows live nonzero proof output and the dashboard/API expose the same evidence.

Validate the plan:

```sh
openspec validate g16-no-theater-swarm-proof --strict
node --check openspec/changes/g16-no-theater-swarm-proof/run-goals-batch.mjs
node openspec/changes/g16-no-theater-swarm-proof/run-goals-batch.mjs --dry-run
```

The `/goals` batch is product/proof-first: it may register goals, start the mock proof path, spawn rollback-scoped demo workers and promote operational demo memory evidence. Release actions remain separate explicit operator commands.
