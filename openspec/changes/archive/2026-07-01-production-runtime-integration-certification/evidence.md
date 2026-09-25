# Evidence: Production Runtime Integration Certification

## Implementation Evidence

- Added `GET /swarms/runtime-readiness` using existing runtime contracts. It reports runtime command, availability, status, version evidence, blocked reasons and `starts_workers: false`.
- Extended Mission Control with `runtime_readiness` and `production_certification`.
- Added dashboard production certification panel model/rendering in Mission Control.
- Added opt-in `integration-spine-real-runtime-smoke.test.ts`.
- Fixed worker worktree snapshotting so real-runtime proof worktrees include current untracked, non-ignored source files before certification.

## Real Runtime Evidence

Command:

```bash
RUN_REAL_RUNTIME_SMOKE=1 REAL_RUNTIME=codex RUNTIME_ALLOW_SKIP_PERMISSIONS=true npm run test --workspace=@djimitflo/server -- integration-spine-real-runtime-smoke.test.ts
```

Result:

```text
PASS src/__tests__/integration-spine-real-runtime-smoke.test.ts
1 passed, 1 skipped
Duration: 234.20s
```

Observed evidence chain:

- Imported low-risk integration event into `work_items`.
- Planned and prepared maker/checker leases with explicit `codex` runtime.
- Confirmed planning did not start workers.
- Drained through existing worker pool.
- Closed loop learning after checker acceptance.
- Created a real production proof run with nested planner and memory-curator sub-agent proof.
- Deterministic proof checks passed after worktree snapshot included current source delta.
- No auto-merge, no deploy and no automatic durable memory promotion were performed.

## Validation Commands

```bash
openspec validate production-runtime-integration-certification --strict
node openspec/changes/production-runtime-integration-certification/run-goals-batch.mjs --dry-run
openspec validate agentic-os-run-chain-proof --strict
npm run test --workspace=@djimitflo/server -- production-runtime-readiness.test.ts worktree-retry.test.ts integration-spine-real-runtime-smoke.test.ts
npm run test --workspace=@djimitflo/server -- github-cocreate.test.ts swarm-resource-plan.test.ts integration-spine-service.test.ts integration-spine-smoke.test.ts
npm run test --workspace=@djimitflo/server -- integration-spine-real-runtime-smoke.test.ts
RUN_REAL_RUNTIME_SMOKE=1 REAL_RUNTIME=codex RUNTIME_ALLOW_SKIP_PERMISSIONS=true npm run test --workspace=@djimitflo/server -- integration-spine-real-runtime-smoke.test.ts
npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts
npm run type-check
npm run build --workspace=@djimitflo/dashboard
git diff --check
```

All listed validation commands passed.
