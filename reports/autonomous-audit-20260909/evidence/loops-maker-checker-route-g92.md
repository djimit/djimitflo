# G92 — `/loops` maker/checker route execution proof

The existing integration test `packages/server/src/__tests__/loop-service.test.ts` was rerun with the focused route-level case:

```text
npm run test --workspace @djimitflo/server -- --run src/__tests__/loop-service.test.ts -t "executes a codex maker lease, captures output, and enforces diff threshold"
```

Result: **1 passed / 24 skipped**.

The disposable repository flow exercises the real loop HTTP route chain: start → continue/leases → `execute-maker` → deterministic checks → `execute-checker` → verify/certify → rejected completion without approval → approved completion. It verifies isolated maker/checker worktrees, diff and read-only gates, captured output, checker acceptance, persisted task/lease state and the mandatory human-approval boundary.

The test uses a disposable fake Codex executable. It is controlled route/evidence proof, not live Astra quality, autonomous merge/deploy or unseen-task improvement.
