# OpenCode event-boundary repair G393

Root cause: `mapJsonEventToExecutionEvent` assumed every structured event had a nested `part`; a flattened `step_finish` emitted by the live OpenCode CLI caused `finishPart.reason` to dereference `undefined` inside the stream. The mapper now falls back to the event envelope, validates tool payloads, and emits typed warning/failure events for malformed data.

Proof: `opencode-executor.test.ts` passes 53/53, including flattened `step_finish`, missing-reason and malformed-tool regressions. The broader governed `/loops` subset passes 35 files / 338 tests / 2 skipped with no `TypeError` or event-stream processing error. Build, type-check, lint and full workspace regression remain green (2,867 passed / 20 skipped / 0 failed).
