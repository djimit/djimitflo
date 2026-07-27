## Why

Djimitflo's core runtime is healthy, but the repository branch has failing gates,
tests that can start a real listener, generated test artifacts, compiler targets
that only emit stubs, and autonomous services whose runtime reachability is not
consistently proved.

## What Changes

- Restore deterministic lint, type-check, build, and test gates.
- Make server startup import-safe and validate production configuration before
  database or network side effects.
- Replace tautological tests with observable lifecycle and UI behavior.
- Expose only compiler targets that produce usable artifacts.
- Keep autonomous test discovery read-only and route implementation through the
  governed self-improvement loop.
- Prove API, operator, and autonomous runtime profiles on temporary databases.
- Use targeted OpenMythos gates for capability truth and behavioral promotion.

## Non-Goals

- New policy engines, scanners, approval layers, or framework dependencies.
- Automatic commit, push, merge, workstation deployment, or production mutation.
- Removing services solely because a static import scan cannot find a caller.

## Success Criteria

- All repository gates pass with no leaked listeners.
- Supported catalog targets never emit stubs.
- The self-improvement API cannot write placeholder tests directly.
- API, operator, and autonomous profiles boot and stop cleanly.
- OpenMythos corpus, lifecycle, and relevant tool-scope gates pass.
- The original dirty worktree remains unchanged.
