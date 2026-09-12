# Actual browser-to-Astra task execution

Two tasks were created and executed through the actual local dashboard at `127.0.0.1:3187`. No REST substitution was used for task creation or Execute. A separately named Playwright browser session recorded requests and received WebSocket frames. Independent read-only SQLite/Git checks and local `npm test` verify the effects.

## Fixture and isolation

Disposable Git repository `/private/tmp/djimitflo-browser-task.xlbXU6`, baseline commit `351ce015894cd25ee05e51b61003137e4251ccf3`, was registered through the existing repository scan UI. Initial `npm test` failed because README contained `STATUS: pending`. The verification script, AGENTS.md and package.json hashes remain unchanged after both workers.

The missing task repository selector was added using existing `api.getRepositories()`, `repository_id` and `metadata.workingDirectory`. No engine dispatch alternative or arbitrary environment override was introduced. Unselected repositories explicitly warn that the runtime default directory will be used. Discovery failures are visible and retryable. Tests prove selected repository/model/reasoning propagation and discovery failure/retry.

The parent configured a temporary server-owned Codex wrapper using `--ignore-user-config --ephemeral --sandbox workspace-write`; explicit task sandbox settings remain respected. Authentication stays in the existing Codex subscription store. This is an isolated audit runtime configuration, not a production default. Both tasks used `gpt-6-astra`, reasoning `low`, local execution mode and the selected fixture directory. Existing policy allowed them without approval; this is not approval/resumption proof.

## Historical first execution

Task `d470002f-3de2-48fb-b0f8-6a7d051b10d4` changed README to `STATUS: verified`. It completed in approximately27seconds, reported68,381tokens, and passed the unchanged npm test. Git HEAD remained unchanged; only README was modified. SQLite contains23execution events,5evidence entries and3task-linked audit entries for creation and Git snapshots/diff.

This first run exposed defects: stderr diagnostics permanently disabled native parsing, successful tool output was misclassified as errors, live execution events omitted their required timestamp, and normal terminal execution lacked a canonical audit event. `browser-task-first-proof.json` therefore explicitly records `observability_complete:false` and zero terminal audit records. It is not retroactively certified by later fixes.

## Corrections and independent second execution

- Codex stream parsing was repaired in its existing adapter by the runtime agent; stdout and stderr no longer share a permanent fallback switch.
- ExecutionEngine's existing event broadcaster now uses the exact durable timestamp/created/updated values. The actual authenticated WebSocket regression failed before this change and passes after; outsider filtering remains enforced.
- The shared terminal status update writes its canonical audit entry in the same SQLite transaction. Completed transitions use `task.executed`/`execution_completed`; failed transitions use `execution.failed`/`execution_failed` and failure outcome. Actor is explicitly the engine (`system`) with the selected agent linked where available. No prompt/output is copied to canonical audit. Replaying the same terminal status adds no duplicate. Injected audit-write failure rolls back status/timestamps and publishes no terminal update. This is not automatic recovery from an unavailable audit database.

Task `506c6e33-af94-44c0-831f-20f004e25f02`, created separately after the rebuilt server was ready, appended `OBSERVABILITY: verified` once and preserved existing README text. It completed in approximately19seconds and reported51,050tokens. The unchanged npm test passed again. Independent checks found14durable execution events,5evidence entries and4audit entries, including exactly one successful `execution_completed` entry.

The browser received24execution frames over the page's existing two connections; every timestamp exactly matches its SQLite event. Native tool-call/result events are present, completion was received, and no heuristic fallback or false error event appeared. `browser-task-second-proof.json` records `observability_complete:true` for this bounded chain, not the entire application.

The first reload encountered the expected expired15minute browser token and is retained as a failed observation. Explicit sign-in followed by detail reload shows persistent completion and tool events with no Invalid Date. Screenshot `output/playwright/audit-browser-astra-completed.png` was captured and visually inspected. Browser CSP data-URL diagnostics remain attributable to the previously documented automation context, not silently suppressed.

## Reproducible evidence

- `evidence/browser-task-fixture-setup.json`, `browser-task-fixture-baseline.log`
- `evidence/browser-task-create-real.log`, `browser-task-completed-real.log`, `browser-task-first-proof.json`
- `evidence/browser-task-second-create.log`, `browser-task-second-running.log`, `browser-task-second-completed.log`, `browser-task-second-proof.json`
- `evidence/browser-task-second-reloaded.log` (expired-session failure), `browser-task-second-reloaded-authenticated.log` (passing persistence observation)
- `evidence/task-repository-selector-{red,final,type-check,lint,build}.log`
- `evidence/execution-event-timestamp-{red,final}.log`, `execution-terminal-audit-{red,final,type-check,lint}.log`

`browser-task-proof.mjs` independently checks SQLite, received frame timestamps, immutable fixture hashes, unchanged Git commit, exact marker/preserved text, README-only diff and actual npm-test output. It does not call a provider. The stored first proof is a historical snapshot; rerunning against a subsequently changed fixture cannot recreate its original file state.

No production repository, external authority, merge, push or deployment was changed. No other runtime or model-quality/economic claim follows from these small fixtures. Browser-driven approvals, cancellation, checker review and whole-loop integration remain separate proof obligations.
