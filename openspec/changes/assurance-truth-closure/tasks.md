# Tasks: Assurance Truth Closure

## Phase 1 — Freeze the evidence contract

- [x] Define the report schema and mandatory gate IDs.
- [x] Add status precedence: `fail` over `blocked` over `pass` only for mandatory gates; informational gates never certify.
- [x] Add redaction tests for secrets and raw credentials.
- [x] Record baseline commit, dirty-state digest and lockfile hash.

Gate: schema validation and focused report tests pass.

## Phase 2 — Supported runtime and dependency truth

- [x] Add CI matrix coverage for Node 20, 22 and 24 using `npm ci`.
- [x] Run full tests, type-check, lint and build in every supported Node job.
- [x] Emit a non-certifying diagnostic when executed on unsupported Node.
- [x] Capture `npm audit --omit=dev --json` and classify each finding as fixed, reachable, unreachable with code evidence, or blocked upstream.
- [x] Fail when a reachable high/critical finding remains.

Gate: all supported Node jobs pass and every production advisory has an evidence-backed disposition.

## Phase 3 — Complete route and MCP contract map

- [x] Enumerate every mounted HTTP method/path from the actual application router.
- [x] Enumerate every registered MCP tool from the actual MCP server.
- [x] Link identities to executable tests, not imports.
- [ ] Add the smallest missing tests for auth, validation, success and not-found/error translation on mutation and trust-boundary routes.
- [ ] Allow exemptions only for generated aliases or transport wrappers with an owner and reason.

Gate: zero unclassified HTTP routes and MCP tools; zero uncovered critical routes.

## Phase 4 — Internal assurance invariants

- [x] Re-run MCP freshness tests at TTL boundaries.
- [x] Re-run latest-proof tests with more than 100 non-proof rows.
- [x] Test Council fast, review and council modes end to end.
- [x] Prove invalid Council reviewer JSON and incomplete rankings fail the session.
- [x] Prove completed Council sessions persist selected content, rankings, scores and disagreement.
- [x] Prove incomplete OpenMythos runs cannot appear in score/trend/certification queries.

Gate: invariant suite passes without network access.

## Phase 5 — OpenMythos evidence maturity

- [x] Validate the canonical corpus and oracle sidecar hashes.
- [x] Separate draft, reviewed and validated cases in all certification queries.
- [ ] Pre-register subject model, judge model, options, case IDs and repetition count.
- [ ] Run deterministic oracle cases before judge-scored cases.
- [ ] Run repeatability and held-out discrimination checks for judge-scored cases.
- [x] Keep lifecycle cases out of the canonical corpus until promotion criteria pass.
- [x] Produce no aggregate certification score when any mandatory evidence gate fails.

Gate: corpus valid; oracle coverage exact; provenance complete; repeatability and discrimination within pre-registered thresholds.

## Phase 6 — Read-only integration certification

- [x] Discover configured Ollama, LiteLLM, Qdrant, Context7, OpenCode, Codex and MCP endpoints from existing configuration.
- [x] Probe each endpoint with a bounded timeout and no mutations.
- [x] Verify requested versus effective model/runtime identity.
- [x] Mark stale persisted health as stale rather than running.
- [x] Record required unavailable services as `blocked` with exact recovery action.

Gate: every required integration has fresh evidence or an explicit blocked result; none is inferred healthy from configuration alone.

## Phase 7 — Live deployment identity and bounded real run

- [x] Compare live commit, instance, host, mode, DB path and config hashes with intended values.
- [x] Run database integrity checks read-only.
- [x] Execute one low-risk temporary-repository maker/checker run through the existing scheduler.
- [x] Close the loop into eval and reflection without automatic memory promotion.
- [ ] Verify proof class, evidence links and `production_missing`.
- [x] Pause for approval if deploy/restart is required to remove identity drift.

Gate: live identity matches, integrity passes and one bounded non-mock run has complete evidence.

## Phase 8 — Closure

- [ ] Run strict OpenSpec validation.
- [ ] Run the complete supported-Node gate set.
- [x] Generate the final assurance report and evidence index.
- [x] Confirm no secret, push, merge, deploy, corpus promotion or durable-memory promotion occurred without approval.
- [ ] Mark the change complete only when all mandatory gates pass; otherwise leave it `blocked` with the smallest next safe action.

Final commands:

```bash
node openspec/changes/assurance-truth-closure/run-goals-batch.mjs --dry-run
openspec validate assurance-truth-closure --strict
npm ci
npm test
npm run type-check
npm run lint
npm run build
npm audit --omit=dev --json
git diff --check
```
