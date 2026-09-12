# Independent cognitive review and proposed no-provider loop proof

## Review result

Correctness: one remaining concrete same-cohort overlap was reproduced and repaired with parent authorization. Ten distinct episodes, five failures/five successes, all duration 1000 ms, using strategy `learned_from_fixture_outcome_correlation` collided with generated goal-aggregate advice. The service reported 20 observations and 500 ms average, while the durable oracle remained 10 observations and 1000 ms. The corrected projection prefers the explicit matching strategy cohort over its overlapping goal aggregate. A regression covers repeated evolution and fresh service construction. Evidence: `cognitive-overlap-red.log` and `cognitive-overlap-green.log`.

The final focused run passed **48/48 across six cognitive/learning suites**. Server type checking and scoped lint passed. This is a bounded projection-fidelity result, not measured task-success improvement.

Subsequent actual HTTP validation exposed global-five batching leaving current strategy/meta projections stale. The shared recorder now refreshes projections atomically for every new unique outcome. Mixed unrelated cohorts and an incomplete last batch are covered without explicitly calling evolution. Latest focused run: **49/49**, with type check, lint and diff check passing; see `cognitive-current-projection-red.log` and `cognitive-current-projection-green.log`. Full-history scaling is an explicit limitation, not a performance guarantee.

The final historical-cache regression also proves service `start()` reconstructs stale persisted projections from unchanged durable rows before event subscription. Constructor behavior is unchanged and repeated start adds no observations. Latest focused checkpoint: **50/50**, type check/lint/diff check pass; `cognitive-restart-projection-red.log` and `cognitive-restart-projection-green.log`.

Positive observations: repeated deliveries are deduplicated by loop identity; immutable historical duplicates are not deleted; recreation reads durable rows; existing projection IDs remain stable; self-reported effectiveness is separated from recorded outcomes; absent use timestamps remain absent. The new file-backed reopen regression checks actual persistence, not only instance replacement.

Security: this diff introduces no external execution or new approval authority. Performance: full-history extraction remains unbounded and repeatedly reads episodes for meta-learning; no scale guarantee was established. Maintainability: the overlap repair reuses the existing projection grouping rather than introducing a new store. Outcome truth remains limited: `recordEpisode` accepts reported outcomes, and a completed loop event is not independently adjudicated task effectiveness or causal intelligence. No automatic application of the recommended strategy was found in the inspected callers.

## Smallest feasible useful controlled execution — proposed, not executed here

Use the parent's isolated local server and already-authenticated operator context. Create a fresh disposable Git repository with one local fixture commit, no remote, no dependencies and these three files; do not reuse the original dirty checkout or an old paid benchmark fixture.

`README.md`:

```md
# Arithmetic fixture
TODO: Correct the add function and satisfy the arithmetic test.
```

`package.json`:

```json
{"name":"djimitflo-local-check-proof","private":true,"type":"module","scripts":{"test":"node --test arithmetic.test.js"}}
```

`arithmetic.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
const add = (a, b) => a - b; // Deliberately wrong local fixture.
test('addition obeys its declared result', () => assert.equal(add(2, 2), 4));
```

A fixture commit is needed because the existing continuation creates actual Git worktrees. It does not require a push, repository registration, provider invocation or seeded database status. Create files through the normal patch mechanism, then run `git init`, `git add README.md package.json arithmetic.test.js`, and a fixture-local `git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m 'Local deterministic check fixture'` inside that exact disposable directory.

Use the existing authenticated request mechanism without printing access tokens. Substitute the actual absolute fixture path, returned run ID and returned maker lease ID:

| Request | JSON body | Property to inspect |
|---|---|---|
| `POST /api/loops/start` | `{"loop_name":"doc-drift-and-small-fix-loop","repository_path":"<absolute disposable fixture>","max_findings":1}` | Real read-only scanner finds README TODO; returned status planning and finding ID |
| `POST /api/loops/runs/<run>/step` | `{}` | Advisory decision continue; this endpoint does not itself execute work |
| `POST /api/loops/runs/<run>/continue` | `{"runtime":"mock","max_assignments":1}` | Actual isolated worktree and prepared maker/checker leases; no seeded completed rows |
| `POST /api/loops/runs/<run>/execute-worker` | `{"lease_id":"<maker>","timeout_ms":10000,"skip_permissions":false}` | Actual Node mock child exits and stores stdout/trace/checkpoint/manifest; explicitly only echo execution, not a code fix |
| `POST /api/loops/runs/<run>/run-checks` | `{"lease_id":"<maker>","scripts":["test"],"timeout_ms":10000}` | Actual npm/Node test fails with expected 4 versus actual 0; check exit status nonzero, stdout/stderr paths and blocked run/failed maker |
| `POST /api/loops/runs/<run>/verify` | `{}` | Materializes actual failed verification gates after the failed maker/check result |
| `POST /api/loops/runs/<run>/continue` | `{"runtime":"mock","max_assignments":1}` | Expected 409 `LOOP_FAILED_GATES_BLOCK_CONTINUE`; no new worktree/dispatch |
| `GET /api/loops/runs/<run>/review-bundle` | none | Durable finding, assignment, process evidence, failed deterministic check and unresolved checker; read actual log files and unchanged fixture bytes |

Useful output is the executable defect report and blocked completion chain. This demonstrates real discovery, worktree preparation, child lifecycle, deterministic test execution and durable failure reporting. It **does not** demonstrate code repair, an independent AI checker, human approval, self-improvement, promotion or engineering intelligence.

The no-dispatch shortcut is not supported by current code: start/step followed by run-checks has no maker and returns 404 `MAKER_LEASE_NOT_FOUND`; manual continuation creates a prepared maker and run-checks then returns 409 `MAKER_LEASE_NOT_COMPLETED`. Checks require an actually completed maker. Failed checks change the maker to failed, so merely editing its files does not permit rechecking either; existing retry creates a new prepared worktree and needs another real explicit runtime step. Do not simulate a completed row to bypass these requirements. `run-checks` itself updates worker checks and run status, but `/verify` is necessary before asserting failed `gates_json` blocks another continuation.

Do not call `execute-checker` with mock: the built-in mock checker prints a hardcoded accepted verdict and would add no independent quality proof. Do not submit manual checker/security verdicts or call complete. Do not install dependencies or start external runtimes. Keep nested spawning absent; this is an ordinary maker lease, not a spawn-tree fixture. Optional eventual cleanup must target only this returned run and its disposable repository/worktrees, preserving the captured report first.

The existing historical `controlled-runtime-improvement.json` documents a supervised paid Codex run; it is not evidence that this new fixture was executed. No local server start, API execution, new Git fixture or provider call was performed by this read-only planning subtask.
