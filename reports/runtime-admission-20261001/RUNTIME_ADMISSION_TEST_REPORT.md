# Runtime admission: test report

## Files changed

| File | Why |
|---|---|
| `packages/server/src/execution/runtime-admission.ts` (new) | contract, decision rules, version matching, ledger (11 executor records plus the OpenHuman negative control) |
| `packages/server/src/execution/execution-engine.ts` | `admitRuntime()`, called after executor lookup and on every attempt or fallback; records an event per decision; shadow rollback |
| `packages/server/src/services/stall-watch.ts` | detector 6: an admission expires within 30 days |
| `packages/server/src/__tests__/runtime-admission.test.ts` (new) | 33 tests |
| `packages/server/src/__tests__/{loop-service,loop-security-checker,nested-spawn-loop}.test.ts` | One line each: `RUNTIME_ADMISSION_MODE=shadow`, because these suites drive fake CLIs that report `fake-codex 1.0.0`, which is not the admitted artifact. No assertion changed; admission is still recorded. |
| `reports/runtime-admission-20261001/*.md` | the four deliverables |

## Results (local, worktree at origin/main 47818d5b + this change)

| Check | Result |
|---|---|
| `vitest` server, full suite | **485 files, 3 367 passed, 0 failed, 22 skipped** |
| `runtime-admission.test.ts` | 33/33 |
| Falsification of the enforcement tests | With `RUNTIME_ADMISSION_MODE=shadow` the three engine-enforcement tests fail (RA-02, RA-11, RA-15): the tests depend on the gate |
| `npm run type-check` (all workspaces) | exit 0 |
| `npm run lint` (all workspaces) | exit 0; 1 warning, unrelated and pre-existing (`github-pr-review-llm.test.ts:122`) |
| Baseline regression | First full run: 16 failures, all fake-binary drift denials plus one ordering change ("throws when executor not found"). Fixed by restoring lookup-before-admission and running the three fake-binary suites in shadow mode. |
| Mutation tests / CodeQL / security-scan | Not run locally (CI jobs) |
| Prod probe of `runtime_contract_probes` versions | **Not run**: the classifier blocked the read-only prod query. The pinned versions match the Dockerfile; a mismatch in prod would show up as a drift denial on the first task. |

## Invariant coverage

| Invariant | Test |
|---|---|
| RA-01 unknown runtime cannot execute | `RA-01`, engine `RA-02/RA-05` |
| RA-02 registered ≠ admitted | engine `RA-02/RA-05` (`custom` registered, denied, executor never started) |
| RA-03 version/artifact bound | `RA-03`, `binary hash change`, `several versions` |
| RA-04 critical FAIL not compensable | `RA-04/RA-07` ×3, private dependency + legacy |
| RA-05 no self-attestation | `RA-05`, engine test with `runtime_admission: ADMIT` in task metadata |
| RA-06 authority conflict fails closed | `RA-06` ×4 (RUNTIME/SHARED → REJECT, UNKNOWN → HOLD) |
| RA-07 unknown licence/reproducibility | `RA-07` |
| RA-08 missing cancellation | `RA-08` |
| RA-09 evidence-less PASS | `RA-09` |
| RA-10 child agents | `RA-10` (decision level; Djimitflo-spawned children covered by the existing nested-spawn suites) |
| RA-11 drift invalidates | `RA-11` ×2 (algebra + engine with a post-boot probe row), stale pre-boot probe ignored |
| RA-12 expired cannot execute | `RA-12` |
| RA-13 explicit gap | `RA-13` |
| RA-14 gym evidence required / regression | `RA-14` |
| RA-15 fallback no bypass | engine `RA-15` |
| RA-16 decisions auditable | engine `RA-02/RA-05` asserts the event row |
| Negative control | OpenHuman → REJECT with the report's reasons |
| Positive control | synthetic all-PASS → ADMIT; opencode 1.18.10 → LEGACY_ADMITTED and runs; opencode 1.19.0 denied; every registered executor is admitted (behaviour preserved) |

## Remaining NOT_PROVEN

1. No third-party runtime has full G5 containment: network egress of CLI children is unscoped.
2. Seven legacy records are not version-bound; `--version` is runtime-reported. Only atomic has a checksum pin.
3. opencode supply chain: no npm provenance attestation, and the global install has no lockfile.
4. Real gym comparisons exist only for opencode, atomic and remote.
5. Prod probe versions are unverified (blocked read). Watch the first prod tasks for `runtime drift` events.

## Migration

Each legacy record moves to a full assessment before 2026-12-31 (stall warning from 2026-12-01). When it is assessed:

- **Clean assessment:** the record drops `legacy` and either reaches ADMIT or CONDITIONAL, or goes to HOLD and stops running.
- **Unused runtimes** (hermes, gemini, editor, pi): candidates for retirement instead of assessment.

Not pushed, merged or deployed.
