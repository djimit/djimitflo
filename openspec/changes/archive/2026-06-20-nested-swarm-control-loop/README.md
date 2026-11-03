# Nested Swarm Control Loop (L1–L4 MVP)

This change makes djimitflo's nested-spawn control loop real (L1 HTTP control loop, L2 per-depth budget ceiling, L3 token-or-user auth), adds the L4 MVP (skill injection + `claude`/`gemini`/`editor` loop runtimes + ordered discussion turns with a computed-on-read next-speaker selector), adds tasks-path `ExecutionEngine` executors for `claude`/`gemini`/`editor`, and hardens the parallel-load flake deterministically.

It is complete when the nested-spawn e2e tests are green deterministically, the new runtimes build and probe correctly via fake binaries, a non-mock runtime self-spawns over HTTP, the discussion-turn and tasks-path executor tests pass, and `type-check` + `lint` are clean across all workspaces.

Validate the plan:

```sh
openspec validate nested-swarm-control-loop --strict
cd packages/server && npx vitest run \
  src/__tests__/nested-spawn-loop.test.ts \
  src/__tests__/runtime-command.test.ts \
  src/__tests__/worktree-retry.test.ts \
  src/__tests__/proof-run-service.test.ts \
  src/__tests__/discussion-turns.test.ts \
  src/__tests__/claude-executor.test.ts \
  src/__tests__/gemini-executor.test.ts \
  src/__tests__/editor-executor.test.ts
```

The loop-path runtimes inherit the existing default-deny security posture (`RuntimeSemaphore`, env allowlist, cwd boundary, `RUNTIME_ALLOW_SKIP_PERMISSIONS` gate). The tasks-path executors inherit the pre-existing tasks-path posture (full `process.env` passthrough + per-executor `*_SKIP_PERMISSIONS` env gate) and the existing `execute:task` + risk-classifier + approval-policy gates. The discussion `tick` is a computed-on-read hint that spawns nothing. Real `claude`/`gemini`/`cline` smoke runs cost tokens and are manual/optional; the suite proves the paths with fake binaries.