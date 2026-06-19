# Nested Swarm Control Loop (L1–L4 MVP)

This change makes djimitflo's nested-spawn control loop real (L1 HTTP control loop, L2 per-depth budget ceiling, L3 token-or-user auth), adds the L4 MVP (skill injection + `claude`/`gemini`/`editor` loop runtimes), and hardens the parallel-load flake deterministically.

It is complete when the nested-spawn e2e tests are green deterministically, the new runtimes build and probe correctly via fake binaries, a non-mock runtime self-spawns over HTTP, and `type-check` + `lint` are clean across all workspaces.

Validate the plan:

```sh
openspec validate nested-swarm-control-loop --strict
cd packages/server && npx vitest run \
  src/__tests__/nested-spawn-loop.test.ts \
  src/__tests__/runtime-command.test.ts \
  src/__tests__/worktree-retry.test.ts \
  src/__tests__/proof-run-service.test.ts
```

The new runtimes inherit the existing default-deny security posture (`RuntimeSemaphore`, env allowlist, cwd boundary, `RUNTIME_ALLOW_SKIP_PERMISSIONS` gate). Real `claude`/`gemini`/`cline` smoke runs cost tokens and are manual/optional; the suite proves the path with fake binaries. The discussion protocol (L4 part 2) and `ExecutionEngine` executors for the new runtimes are deferred to a later change.