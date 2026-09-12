# G162 — authenticated proof-run UI and rollback traversal

Date: 2026-09-10

## Fixture

- Built dashboard served by a temporary local server on `127.0.0.1:3187`.
- Fresh temporary SQLite database and admin bootstrap; no production data or
  external services were mutated.
- Browser session authenticated as `ui-audit@example.test`.

## Executed chain

1. Opened `/swarm-mission-control`.
2. Used the visible **Production Swarm Proof** `mock` selector and **Run
   Proof** action.
3. Observed a persisted `passed` proof run with 6 capabilities, 1 panel, 3
   reviews, 3 claims, 1 goal, 1 loop run, 4 worker leases, 5 trace spans, 2
   checkpoints, 4 manifests, 1 memory candidate and 1 work item.
4. Followed the generated link to
   `/swarm-mission-control/proof-runs/proof-1789024292676-aac6ce49`.
5. Verified the detail route rendered runtime, status, minimums, artifact
   references and narrative.
6. Activated **Rollback this proof run**. The UI returned `rolled_back`,
   `rollback safe: yes`, zero persisted artifact counts and the expected
   rollback narrative.
7. Reloaded the detail route. It returned the intentional `404 Not found`
   state because rollback removes all proof-tagged demo records. This matches
   the existing service contract and integration test; it is not a silent UI
   success.

## Result

`VERIFIED` for the create → persisted evidence → detail → governed rollback
chain. `INTENTIONAL` for post-rollback detail disappearance: the current
rollback contract is destructive cleanup of demo artifacts, not an audit
tombstone. The browser harness also emits known `data:,` CSP probe errors;
they are harness noise, while the post-rollback 404 is the expected API
response.

