# G173 mutation recheck

`npm run test:mutation` completed against the current tree.

```text
81 mutants instrumented
All files: 100.00% mutation score, 71 killed, 0 survivors, 0 errors
Break threshold: 70 (passed)
```

The mutation configuration remains scoped to the existing executor, approval-service and ToolBroker invariants; this is meaningful coverage for those boundaries, not proof that every route mutation is covered.

Re-run after G174 route/error-boundary changes (2026-09-10) produced the same result: 81 mutants instrumented, 71 killed, 0 survivors and 0 errors; break threshold 70 passed.

G177 re-run after the G176 canvas validation changes also passes directly: 81 mutants instrumented, 71 killed, 0 survivors and 0 errors; break threshold 70 passed. The configured mutation scope is unchanged.

G178 re-run after the Apex worker and Live Canvas resource-boundary fixes also passes directly: 81 mutants instrumented, 71 killed, 0 survivors and 0 errors; break threshold 70 passed.

G181 re-run after runtime-governance and repository-index resource guards also passes directly: 81 mutants instrumented, 71 killed, 0 survivors and 0 errors; break threshold 70 passed.
