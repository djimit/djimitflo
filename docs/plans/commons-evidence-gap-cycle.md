# Commons idea to verified change — 2026-09-13

The first cycle follows the four real CLI/DeerFlow exchanges completed on production commit `156962b78e55ab62d19198dcfc8f5723c5c04fe8`. Their common challenge was that claim count does not establish evidence coverage.

## Proposal review

| Runtime / candidate | Assessment | Decision for this cycle |
| --- | --- | --- |
| Claude / `ee24400c-df8b-4f77-83d3-183339754b01` | Explicitly distinguishes a missing acceptance specification from missing evidence; predicts that a redundant third claim can silence the current detector. | Select the falsifiable count-sensitivity experiment and repair the proven defect. |
| OpenCode / `ca41d822-ced7-4a00-9818-eab633de34da` | Overlaps with Claude; automatic de-escalation requires a real required-slot contract. | Retain as related evidence; do not implement ungrounded coverage approval. |
| Pi / `128e16a4-6984-4f61-bee1-f6269d26c086` | Adds source-independence concerns but explicitly admits the proposed four-slot taxonomy is unverified. | Defer the new validator until its contract is established. |
| Gemini / `7e6970c2-8e97-4d76-8c0d-0d4e4a795842` | Proposes semantic information gain and automatic rejection; no calibrated classifier or acceptance set exists here. | Defer the new scorer and automatic rejection. |

## Verified source of the problem

`CuriosityService.detectCoverageGaps` counts every row in `swarm_claims`, including the gap claims that `scanForGaps` itself publishes. The source of this detector is Djimitflo, not DjimitKBWiki. The production domain `proof:proof-1782654612849-7edd60a1:worker-evidence` contains exactly one substantive observation and two curiosity diagnostics. The original `< 3` query therefore returns no coverage signal despite no additional worker evidence.

`ProofRunService.createClaims` creates the worker-evidence observation with maker/checker lease references. The actual proof code has runtime and usage checks; it does not declare the agents' suggested universal identity/task/hash/timing coverage schema. This cycle must not invent that schema or claim complete coverage.

## Execution plan

1. Preserve production proposal/review state and take a read-only sample of the source claims.
2. Reproduce the disappearing signal with a regression test and the sampled rows.
3. Exclude diagnostics and inactive evidence from the inventory signal; keep exact duplicate statements from inflating it. Label the result a count heuristic with coverage unknown.
4. Make repeated scans idempotent for unchanged diagnostics and preserve existing review decisions.
5. Have a separate agent review the change and its social-topic/goal consumers, run focused and integration checks, and open a PR with measured before/after evidence.
6. Inspect existing Paperclip routines for recurring CLI participation. Reuse admitted runtime paths, native run budgets and pause controls. Keep operator credentials on the control host and scoped runtime tokens out of model processes.

## Boundaries

The four production proposals remain candidates. This work does not approve, merge or deploy an agent proposal automatically. No new scheduler, semantic model, coverage schema or task authority is needed for the proven counting defect. Existing historical diagnostics remain intact; a separate governed review can classify old alerts.

The prior activation report is historical: PRs 219, 220 and 222 are now merged and production activation was verified. Four CLI runtimes completed bounded participation; that alone does not establish recurring CLI operation.

## Executed result

The production-row replay on an isolated migrated SQLite database reproduced the defect: the original implementation emitted zero coverage signals for one substantive claim plus two diagnostics. The revised implementation emitted one explicitly uncertain inventory signal, retained it on the second scan, and published zero duplicate diagnostics on that second scan. The regression suite also verifies that exact normalized duplicate statements cannot silence the signal, inactive claims do not inflate inventory, and rejected/resolved review decisions are preserved.

Eight regression cases failed against the original service. After the repair, 34 relevant tests and the server typecheck passed. An independent reviewer separately ran 26 Curiosity/GoalFormation/Commons tests and found no blocking issues. The same detector's contradiction count alias was corrected and tested to produce finite severity.

To reproduce the public regression checks:

```sh
npm ci
npm run build -w @djimitflo/shared
npm run build -w @djimitflo/agent-catalog
npm test -w @djimitflo/server -- src/__tests__/curiosity-service.test.ts src/__tests__/goal-formation.test.ts src/__tests__/agent-social-commons.test.ts
npm run type-check -w @djimitflo/server
```

Local source-row replay evidence is retained at `.data/commons-gap-cycle/replay.json` in the isolated implementation worktree. Production records were read, not modified. Existing historical gaps remain available for governed review. Three distinct statements still only suppress this inventory heuristic; they do not prove semantic coverage. Deployed autonomous goal generation uses a separate `knowledge_gaps` source, so this change makes no claim of end-to-end goal-generation improvement.
