# Evidence

Verified on 2026-07-27 in the isolated repair worktree.

## Closed loop

The HTTP contract test proves:

1. a persisted OpenMythos discovery failure;
2. two additional pre-change evaluations;
3. a real task dispatch through the ExecutionEngine contract;
4. three post-change evaluations over the same target and holdout cases;
5. paired-delta and confidence-bound calculation;
6. promotion only after verified gain with a stable holdout;
7. persisted task, run and verification-manifest lineage.

Production defaults are three repeats, minimum effect 0.1 and maximum holdout
regression 0.1. A one-sided 95 percent t lower bound is used for repeated paired
run means.

## Reproducibility

Three live OpenMythos runs against `openmythos-r16:latest` each produced:

- status `completed`;
- score 5;
- 2,330 tokens;
- corpus SHA-256
  `71ca62e742f71c2830f198c01dbcacdcf75487b9ef96e661d3e297d6608d41b9`.

Five independent self-analysis runs each produced:

- 354 source files and 80,362 lines;
- 69 executable routes;
- 22 routes with HTTP and service evidence;
- 12 HTTP-only;
- 35 service-only;
- 0 uncovered;
- 54 self-modification opportunities: 47 integration gaps and 7 complexity
  hotspots.

The former scanner reported 71 filename gaps. It now delegates to the same
route-service-test evidence matrix used by self-analysis.

Five `npm run benchmark:self` runs each passed all 3 functional checks.

## Removal

Retired production-unreachable or fictive paths:

- `RealExperimentRunner`;
- `DjimFloGovernanceEvaluator`;
- `GovernanceFeedbackLoopExperiment`;
- unused `SelfImprovementService`;
- `SegmlLevel5Bridge` and `/api/segml/l5`.

The SEGML production router no longer exposes its competing `/evaluate` or
`/cycle` endpoints. Canonical evaluation and promotion are OpenMythos and
governance-feedback.

Combined with the preceding execution-attempt closure, the worktree has 2,716
deleted lines and 769 added lines before OpenSpec evidence files.

## Gates

- Focused self-improvement and route tests: 78/78 passed.
- Server suite: 1,661 passed, 19 skipped.
- Full workspace suite: 1,755 passed, 19 skipped.
- Type-check: passed.
- Lint: passed.
- Build: passed.
- `git diff --check`: passed.

## Boundary

No production database was mutated. No service was restarted. No deployment,
commit or push was performed.

SEGML Level 3/4 research bridges still contain explicitly simulated research
behavior. They are outside this production-authority closure and must not be
used as promotion evidence.
