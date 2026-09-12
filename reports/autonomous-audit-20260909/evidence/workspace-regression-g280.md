# G280 workspace regression

The first parallel workspace run exposed one non-deterministic `loop-service.test.ts` security-checker lease assertion (`404` instead of `201`). The same file passed isolated at 50/50, and the complete workspace rerun then passed across all packages: 2,827 tests passed, 20 skipped, 0 failed. This transient is retained as an intermittent rather than silently treated as a product failure.
