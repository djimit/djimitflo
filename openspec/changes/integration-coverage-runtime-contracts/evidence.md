# Evidence

## Baseline

- Source commit: `925d4890`.
- Three shuffled seeds (`101`, `202`, `303`): each 121 passed, 2 skipped.
- Full monorepo: 1742 passed, 19 skipped.
- Live task success: create 201, execute 200, completed in 7002 ms with 9
  persisted events.
- Live task defects:
  - invalid `execution_mode` returned 500 after a SQLite CHECK failure;
  - unknown executor returned 500 `INTERNAL_ERROR`.
- Live OpenMythos case `hierarchy-001`: eval 201, completed in 9.4 seconds;
  score, report, and trend returned 200.
- OpenMythos corpus: 351/351 valid.
- Skill lifecycle: 18 drafts, 6 stages, no promotion.

## Closure

- Task HTTP contract: 8 tests cover auth, create-to-completion, persisted risk
  and events, enum validation, executor validation, and cancellation conflict.
- OpenMythos HTTP contract: 5 tests cover exact-case eval, score, report, trend,
  auth, invalid input, missing evidence, missing config, and evidence lineage.
- Proof-run latest covers empty and populated state without duplicate Express
  error propagation.
- Loop runtime contracts expose all 8 runtimes without leaking a secret
  sentinel.
- Self-improvement stats now identify `direct_test_file_match` and report
  integration coverage as unknown instead of treating filename matching as
  functional coverage.
- Request IDs are propagated to response headers, error bodies, and structured
  request logs. Expected 4xx responses no longer log error stacks.
- Shuffled seeds `101`, `202`, and `303`: each 8 files passed, 72 tests passed,
  2 skipped.
- Server suite: 191 files passed, 1 skipped; 1664 tests passed, 19 skipped.
- Monorepo: 1755 tests passed, 19 skipped.
- Lint, type-check, production build, and `git diff --check`: passed.
- OpenMythos: 351/351 cases valid; skill lifecycle reports 18 draft cases,
  6 stages, exact oracle coverage, and no promotion.
- Agent-skills maximum evaluation: 156/156 valid; all manifest, tier-0, and
  lifecycle thresholds passed; embedded OpenMythos gate passed.
- Live autonomous task: invalid mode 400 `INVALID_INPUT`, unknown executor 400
  `INVALID_EXECUTOR`, valid create 201 and execute 200, final `completed` with
  9 events.
- Live routes: 8 runtime contracts, empty proof latest 404 without duplicate
  stack logging, and request ID echo verified.
- Live OpenMythos `hierarchy-001`: eval 201 completed against workstation
  Ollama; score, report, and trend all returned 200.
- Both live server runs stopped cleanly; the temporary SQLite database was
  removed.
