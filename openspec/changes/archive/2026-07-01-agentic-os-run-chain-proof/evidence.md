# Evidence: Agentic OS Run Chain Proof

## Current Proof

The deterministic smoke is `packages/server/src/__tests__/integration-spine-smoke.test.ts`.

It proves one imported integration event flows through:

1. `POST /work-items/integrations/import`
2. `POST /swarms/scheduler/tick`
3. `POST /swarms/worker-pool/plan`
4. `POST /swarms/worker-pool/drain`
5. `POST /swarms/evolution/close-loop`
6. `GET /swarms/intelligence/mission-control`

The smoke asserts:

- source event and `work_item` are preserved
- explicit `mock` runtime becomes effective maker/checker runtime
- planning prepares leases without starting workers
- worker/checker drain stores trace spans and runner manifests
- learning closure creates eval, reflection and memory candidate
- memory remains proposed, not promoted
- Mission Control exposes the integration chain and next safe action

## Verified Commands

```bash
openspec validate agentic-os-run-chain-proof --strict
node openspec/changes/agentic-os-run-chain-proof/run-goals-batch.mjs --dry-run
npm run test --workspace=@djimitflo/server -- swarm-resource-plan.test.ts
npm run test --workspace=@djimitflo/server -- integration-spine-smoke.test.ts integration-spine-service.test.ts swarm-resource-plan.test.ts
npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts
npm run type-check
```

Final build and diff gates are tracked in `tasks.md`.
