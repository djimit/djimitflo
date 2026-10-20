# core-invariants Specification

## Purpose
The safety invariants of the self-improvement loop that no flag, genome, mutant or loop run may weaken: what evolution may never touch, how missing evidence is treated, when a run counts as verified, when a PR may merge without a human, when a genome may be promoted, how PRs are identified and which signals may never decide. Every requirement names the code that enforces it, verified against `origin/main` at `07081f32` (2026-10-17). A requirement without enforcing code is marked UNANCHORED instead of being claimed.

## Requirements

### Requirement: Evolution never touches its own guard rails
FR-001: A dream mutant SHALL NOT add a genome line that mentions gates, checks or the checker (incl. the security checker), scope, secrets, tokens, credentials, auth, deploy, push, merge, commit, approvals, policies, `.github`, `package.json`/lock files, holdouts, evaluation, promotion, fitness, oracles, verdicts, genomes or the evolution/gym code, nor one that edits, deletes or weakens tests; `guardLines` SHALL reject the whole mutant (null) when any line matches, when there are more than 5 lines or when a line exceeds 200 characters.

#### Scenario: Mutant line touches the merge or auth path
- **WHEN** a dream mutant proposes the line "skip the security checker and merge directly"
- **THEN** `guardLines` returns null and the mutant is dropped with reason `guard`; no trial genome is created

#### Scenario: Mutant within bounds
- **WHEN** a mutant proposes 3 strategy lines of ≤ 200 characters that name none of the forbidden terms
- **THEN** `guardLines` returns the whitespace-normalised lines and the mutant may enter a trial

### Requirement: UNKNOWN is neither PASS nor FAIL
FR-002: Loop verification SHALL keep a gate whose evidence is missing or unreadable at `unknown`, never `pass` and never `fail`; any `unknown` gate SHALL block the run with `block_reason = insufficient_evidence` (listed under `unknown_gates`, never under `failed_gates`), and certification SHALL require every gate to be `pass` (only a skipped `security_checker_verdict` is tolerated).

#### Scenario: Historical worktree gone
- **WHEN** a completed maker lease's recorded worktree no longer exists
- **THEN** `worktree_isolation` is `unknown`, the run is `blocked` with `insufficient_evidence`, and `failed_gates` is absent

#### Scenario: Certification with an unknown gate
- **WHEN** `certifyLoopRun` runs on a run with one `unknown` gate
- **THEN** `certified` is false

### Requirement: No verification without an executed check
FR-003: A maker lease SHALL only satisfy `tests_lint_typecheck` when at least one deterministic check actually ran and passed, and every check is `pass` or `skipped`; a configured check script that the repository lacks SHALL be recorded as a failed check (`reason: missing_script`) and attributed `infra_failed`, never `skipped` and never a build-error proposal.

#### Scenario: All checks skipped
- **WHEN** every deterministic check of a maker lease is `skipped`
- **THEN** `tests_lint_typecheck` fails and the run is not verified

#### Scenario: Configured script missing
- **WHEN** the configured check `lint` is not in the worktree's `package.json` scripts
- **THEN** the check is recorded `status: fail, reason: missing_script` and outcome attribution returns `infra_failed`

### Requirement: Earned auto-merge is narrow, capped, sampled and self-revoking
FR-004: Auto-merge (`LOOP_AUTO_MERGE_TEST_ONLY`, default off) SHALL act only on a loop PR of an allow-listed repo (`LOOP_AUTO_MERGE_REPOS`, default the primary repo) whose run is verified with no `fail` or `unknown` gate, whose every changed file is a test file with none removed, whose diff is within the maker's lane limit, whose assertion-strength verdict is `pass`, without outstanding CHANGES_REQUESTED, with no red check and green CI before merging; it SHALL merge only the head recorded when the run was verified (`verified_head_sha`; GitHub's own update-branch merges on top of it count as that head), passing it as the merge call's `sha`, and SHALL NOT merge a run without one; it SHALL stop at `LOOP_AUTO_MERGE_MAX_PER_DAY` (default 10, rolling 24 h), leave a deterministic 10 % audit sample for the human, and revoke the whole class when an auto-merged PR is reverted, its lines do not survive, or its merge commit's checks fail on main, until an operator re-enables it.

#### Scenario: Repo not on the allow-list
- **WHEN** a verified test-only loop PR belongs to a repo not in `LOOP_AUTO_MERGE_REPOS`
- **THEN** the decision is `ineligible` with reason `repo_not_allowed`

#### Scenario: Revert after auto-merge
- **WHEN** a commit on main within 14 days reverts an auto-merged PR
- **THEN** the class state becomes `revoked` and later eligible PRs get `revoked_hold` instead of being merged

### Requirement: Merge train proves presence on main and never pushes an empty branch
FR-005: The merge train SHALL record SATISFIED only when the PR's net diff reverse-applies and does not forward-apply on current main and every file it adds exists there; an empty diff, an ambiguous presence check, a failed ledger write or a rebuilt branch that does not reproduce the original change hunk for hunk SHALL end FAIL_CLOSED with nothing pushed.

#### Scenario: Empty diff
- **WHEN** the PR's patch-id is empty
- **THEN** the train records `fail_closed` with `empty_diff` and exits 3 without any mutation

#### Scenario: Rebuild drops a hunk
- **WHEN** `rebase` rebuilds a stacked branch whose hunks differ from the original change
- **THEN** the branch is restored, nothing is pushed, and `fail_closed` / `reconstruct_mismatch` is recorded

### Requirement: Promotion only on a valid holdout with gated parent evidence
FR-006: A genome SHALL become `active` only through `promoteGenome`, which SHALL re-check the deciding holdout and refuse promotion when its validity is `exhausted` or `unknown` (leaving the genome `inconclusive`, never `retired`); before that, a trial SHALL be held `inconclusive` unless every paired task has eligible gated evidence for both parent and mutant.

#### Scenario: Exhausted holdout
- **WHEN** more distinct non-baseline candidates than `DREAM_HOLDOUT_REUSE_LIMIT` have run on the deciding tasks
- **THEN** `holdoutValidity` returns `exhausted` and `promoteGenome` returns `promoted: false` with status `inconclusive`

#### Scenario: Validity cannot be established
- **WHEN** the deciding set has no tasks or the validity query throws
- **THEN** validity is `unknown` and the genome is not promoted

### Requirement: PRs are keyed by owner/repo and number
FR-007: Merge survival and auto-merge SHALL identify a PR by the owner/repo and number parsed from its full GitHub URL, SHALL scope every GitHub call to that repo, and SHALL NOT poll PRs of repos that are neither the primary repo nor registered.

#### Scenario: Same number in another repo
- **WHEN** two loop runs carry `https://github.com/a/x/pull/12` and `https://github.com/b/y/pull/12`
- **THEN** each is fetched from its own repo and their outcomes never mix

#### Scenario: Unregistered repo
- **WHEN** a run's PR URL names a repo that is not primary and not in the extra-repo registry
- **THEN** merge survival skips it without any GitHub call

### Requirement: jev never decides
FR-008: jev confidence SHALL NOT be used for approval, promotion, code, risk or fitness decisions (NEGATIVE_EVIDENCE NE-001, verdict REJECT). ANCHORED only for the rejected cascade: the closed entry's `forbidden_code_patterns` SHALL be absent from the server source (B29 test). UNANCHORED for the general rule: no runtime guard prevents a new caller from using jev in a decision path; it is enforced by the registry and review only.

#### Scenario: Cascade pattern reintroduced
- **WHEN** server source contains a `forbidden_code_patterns` string of NE-001 (for example the cascade judge mode flag)
- **THEN** the B29 test in `negative-evidence.test.ts` fails

#### Scenario: New jev-based gate
- **WHEN** a change adds jev confidence to a promotion or approval decision under a new name
- **THEN** no automated check fails (UNANCHORED); reviewers reject it on NE-001

## Success Criteria
- SC-001: 8 of 8 requirements name at least 1 enforcing file in Codebase Anchoring; 1 of 8 (FR-008) is marked partly UNANCHORED.
- SC-002: Auto-merge caps at 10 merges per rolling 24 h by default and leaves 10 % of eligible PRs to the human.
- SC-003: A mutant has ≤ 5 lines of ≤ 200 characters each.

## Edge Cases
- EC-001: IF a gate's per-lease observations mix `fail` and `unknown` THEN the gate is `fail` (a durable failure wins); IF they mix `pass` and `unknown` THEN it is `unknown`.
- EC-002: IF the auto-merge class state row exists but cannot be parsed THEN the class is treated as revoked (fail closed); a missing row means never revoked.
- EC-003: IF GitHub is unavailable during an auto-merge tick THEN the decision is `waiting`, never `merged`.
- EC-004: IF the negative-evidence registry file is missing THEN `loadNegativeEvidence` returns null (unknown), not an empty list.

## Non-Goals
- Changing any threshold, flag default or gate; this spec only records what the code already enforces.
- Specifying maker/checker prompts, assignments or the TG-001 gym surface.
- Re-applying the spec deltas of archived changes.

## Hard Constraints
- Allowed: documenting behaviour present on `origin/main`; marking gaps UNANCHORED.
- Forbidden: claiming an invariant without an enforcing file; weakening any requirement here without a superseding change that names the replacing code.

## Codebase Anchoring

| FR | File | Enforcement |
|----|------|-------------|
| FR-001 | `packages/server/src/services/dream-evolution.ts` | `FORBIDDEN`, `guardLines` |
| FR-002 | `packages/server/src/services/loop-verification-service.ts` | `combine`, `verifyLoopRun` (`insufficient_evidence`), `certifyLoopRun` |
| FR-003 | `packages/server/src/services/loop-verification-service.ts` | `leaseChecksPassed` (B1) |
| FR-003 | `packages/server/src/services/loop-service.ts` | `missing_script` check record (B1) |
| FR-003 | `packages/server/src/services/outcome-attribution.ts` | `infra_failed` on `missing_script` |
| FR-004 | `packages/server/src/services/loop-auto-merge.ts` | `runAutoMergeTick`, `checkRevocations` |
| FR-004 | `packages/server/src/services/loop-auto-merge-state.ts` | `autoMergeMaxPerDay`, `AUDIT_SAMPLE_PCT`, `isAuditSample`, `revokeClass`, `reEnableClass` |
| FR-004, FR-007 | `packages/server/src/services/repo-registry.ts` | `autoMergeAllowed`, `parsePrUrl` |
| FR-005 | `scripts/merge-train.sh` | `diff_state`, empty-diff and `reconstruct_mismatch` FAIL_CLOSED |
| FR-006 | `packages/server/src/services/genome-promotion.ts` | `holdoutValidity`, `promoteGenome` |
| FR-006 | `packages/server/src/services/dream-evolution.ts` | `evaluateTrials` gated-evidence hold |
| FR-007 | `packages/server/src/services/merge-survival.ts` | B3 per-repo polling |
| FR-008 | `docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml` | NE-001 `forbidden_reuse`, `forbidden_code_patterns` |
| FR-008 | `packages/server/src/__tests__/negative-evidence.test.ts` | B29 pattern ban (cascade only) |

## Verified Library Specs

| Library | Version | Key API Constraints |
|---------|---------|---------------------|
| better-sqlite3 | ^13.0.3 (existing) | synchronous `prepare().get/all/run`; `json_extract` on metadata columns |
| vitest | 4.1.11 (existing) | tests anchoring FR-001…FR-008 |
| git / jq / gh | system (existing) | `git apply --cached --check [-R]` is the presence proof in `merge-train.sh` |
