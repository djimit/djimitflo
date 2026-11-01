# Executable skills through the existing control plane

This opt-in slice uses `swarm_capabilities`, admitted `SkillLoaderService` packages,
existing goals/worktrees, maker/checker leases, execution evidence and capability
promotion. It adds no scheduler, agent registry or approval authority.

## Enable and scope

`SKILL_FIRST_MODE=off` is the default. `shadow` exposes metadata discovery only;
`on` permits explicit factory/capture requests and skill-bound tasks. Register the
operator-reviewed package directory with existing `DJIMITFLO_SKILLS_DIR` and
`DJIMITFLO_SKILL_ALLOWLIST`. No endpoint installs packages or changes the allowlist.

Version 1 supports UTF-8 Node `.mjs` packages, `.test.mjs` tests, primitive object
input/output contracts and at most eight pinned skills in a sequential composition.
Package IDs end in their version, e.g. `text-count-v1-0-0`, with `version: "1.0.0"`.
The logical `capabilities` name stays stable. New versions use new directories;
old versions and evidence remain available. Existing registry deprecation disables
a version; selecting the previous approved version is rollback. If every matching
version is retired, a new request reserves the next patch version and deduplicates
only unfinished work for that package. Completed goals and retired packages remain
historical; replacement does not reactivate or overwrite them.

Every package contains `SKILL.md` and `skill.contract.json`. The contract schema is
`executableSkillContract` in `services/executable-skills.ts`; factory goals include
its JSON schema. Declare every package file and SHA-256 except the contract itself
and optional loader manifest (both also bound by the package digest). Absolute
paths, escapes, undeclared files, changed hashes and non-text payloads are rejected.
Examples must satisfy the declared schemas. File digests do not pin Node, external
libraries or infrastructure; independent checker/security review remains required.

## Request, make, verify, capture, reuse

Use the existing authenticated API session and permissions. Routes below are under
`/api/skills`; no new credential mechanism is introduced.

1. `GET /executable/discover?capability=text-count` returns registry metadata only:
   versions, availability, blocks, tool declarations, dependencies and package hashes.
2. `POST /executable/request` with `{"capability":"text-count","objective":"Count words in a supplied text"}`
   returns available versions, an awaiting-promotion candidate, or an idempotent
   factory goal. A new goal is initially blocked to prevent the general daemon
   from dispatching it into a different loop before explicit factory preparation.
   Optional `source_run_id` uses an existing, hash-checked, survived `skill_cards`
   record belonging to the requester as evidence for extracting a reusable
   procedure. A record is input to the maker, not an executable skill or proof of
   causal improvement.
3. `POST /executable/factory/<goal_id>/prepare` with
   `{"repository_path":"<existing authorized repository>","runtime":"codex"}`
   prepares the existing objective loop and isolated maker worktree. Supported
   automatic factory runtimes are codex, opencode, claude, gemini and pi.
   The same owner can repeat preparation without creating another run.
4. Repeated `POST /executable/factory/<goal_id>/advance` with
   `{"checker_runtime":"claude","timeout_ms":120000}` advances one bounded phase.
   Existing runtime admission, permission approvals, scope/security checks and
   reviewer independence still decide whether execution proceeds. Pending approvals
   remain pending. Mock runtimes cannot generate factory verification receipts.
5. The maker must supply `skills/text-count-v1-0-0/` and exactly the npm script
   `test:skill-package = node --test skills/text-count-v1-0-0/<contract.test>`.
   The existing check service runs test, lint, type-check and test:skill-package in
   a worker thread using the persistent SQLite database. One such check worker runs
   per API process. The API event loop remains responsive. Before/after/current
   package hashes and all existing verification gates must agree before a system
   test-result receipt is issued for the completed maker task.
6. The result is `awaiting_package_admission`, not automatically approved. Use the
   existing review/draft-PR publication chain. An operator admits the reviewed
   package through the existing directory/allowlist mechanism; then
   `POST /text-count-v1-0-0/capture` with `{"task_id":"<returned maker task_id>"}`
   registers a candidate only when the admitted bytes match the verification receipt.
   The factory owner owns that task. Existing capability promotion requires its
   normal evaluation, skill comparison and training evidence; this slice cannot
   approve itself or manufacture that evidence.
7. Discover the approved version on the next task, then use the existing task API
   with metadata such as:

```json
{
  "skill_execution": {
    "selected": [{"capability_id":"skill:text-count-v1-0-0@1.0.0","content_hash":"<discovered SHA-256>"}],
    "tools": ["Bash"],
    "input": {"text":"a bounded example"}
  }
}
```

The composer checks approved exact versions, dependencies, cycles, adjacent schemas
and explicit tool subsets. Store/reuse this same task metadata as the workflow;
there is no second workflow registry. Only selected packages enter the runtime
prompt. Payloads carry the selected files to the existing isolated runtime
workspace rather than requiring a remote maker to access server filesystem paths.
Packages are limited to 64 KB of encoded payload; total composed instructions to
128 KB. Materialization and execution use existing permitted tools; declarations
never grant additional privileges. Assign every component skill to the agent through the existing assignment
interface when an agent is selected. Newly admitted versions are read at task
execution without refreshing the shared legacy loader or restarting the engine.
Composed tasks retain whole-workflow outcomes and package receipts; a successful
workflow is not counted as an independent successful outcome for every skill. Execution rechecks current
package bytes, registry status and exact rendered instructions immediately before
starting the existing adapter, including approval resumes/retries.

## Evidence and operational limits

Tests cover actual Node package execution/reuse, two immutable version directories,
HTTP authorization, factory state transitions, six local CLI adapter input
boundaries and actual off-thread npm checks with persistent SQLite. Factory/model
responses and pre-approved registry rows are explicit fixtures; these tests do not
establish real provider execution or independent production promotion. Runtime
outcome evidence must confirm that a maker actually executed the delivered skill;
a prompt delivery receipt alone is not success.

A durable `skill_factory_dispatch` claim survives API process death. Do not clear
it automatically by elapsed time: reconcile the existing task/process/lease first,
then use the operator's existing recovery procedure. A failed or cancelled run is
not silently replaced. Keep admitted package directories read-only to runtime
workers. This feature neither deploys nor merges and remains off until explicitly
enabled in an authorized environment.

## Candidate evaluation and promotion evidence

An operator-admitted candidate can be evaluated through the existing native task
API without live registry routing. Set `metadata.skillId` and
`metadata.skill_evaluation_package_hash` to its exact loaded package; include its
instructions and the exact JSON-encoded selected payload in the task description.
The engine rechecks admission and bytes before dispatch; existing policy and
execution approval still apply. This is an explicit evaluation task, not a way to
mark a candidate approved. `off` and `shadow` refuse this evaluation path.

The engine records the full delivered package hash. Trusted `system` test-result
receipts must bind `skill_package_id`, `skill_content_hash` and `skill_package_hash`.
Both initial and late verification use the same settlement path. It updates one
existing task/skill/hash outcome, preserves measured usage, and refuses ambiguous
retry attribution. Missing/wrong hashes or unverified execution never become a
successful skill improvement. A delivery receipt alone proves no successful tool
execution; the independent checker must verify the actual output and package.

For immutable versions, promotion accepts `baseline_capability_id` together with
`baseline_skill_content_hash`. Baseline and candidate must have the same logical
family, compatible input/output contracts, dependencies and permission scope.
Each cohort uses its own immutable skill ID and full package hash. Include both
`skill_outcomes:<skill-id>:<instruction-hash>` references. Readiness returns the
same pinned promotion input. Existing 30-per-cohort, improvement, OpenMythos,
training and security requirements remain unchanged. A first family needs an
honest independently evaluated reference version; it has no bootstrap exemption.

## Activation hold (2026-10-31)

The independent review's immutable-baseline and retired-goal defects are repaired;
full provider → promotion → approved reuse is still **not verified**. Release with
`SKILL_FIRST_MODE=off` is distinct from activation. The installed local OpenMythos
corpus has `certification_ready:false`, and the real training runner fails with
six split recommendations. Those observations are local prerequisites, not a claim
that production has the same files. Production had no training runner configured
at the last check. Do not set eligibility flags, reduce thresholds or manufacture
outcomes to obtain approval. Retain the activation hold until genuine evidence
satisfies every existing gate.

## Resolve an explicit capability intent at task creation

Instead of supplying a registry ID and hash, an authenticated caller can submit the
following metadata to the existing `POST /api/tasks` endpoint (`SKILL_FIRST_MODE=on`):

```json
{
  "title": "Normalize a label with an approved package",
  "description": "Use the existing capability and return its JSON output.",
  "use_swarm_context": false,
  "metadata": {
    "capability_intent": {
      "capability": "normalize-label",
      "tools": ["Bash"],
      "input": {"value": "A bounded label"}
    }
  }
}
```

The resolver reads registry metadata first, selects the latest compatible approved
version, then loads only the selected package and its pinned dependencies. It
persists `skill_execution`, exact package receipts and
`resolved_capability_intent`; the unresolved intent is consumed. A later retry
revalidates that exact version, never silently upgrades it. New tasks may resolve a
new approved version. Missing/unapproved capabilities fail with
`SKILL_CAPABILITY_UNAVAILABLE`; use the existing executable request/factory path to
prepare missing work. No task or factory goal is created by a failed resolution.

Maker leases can carry the same `capability_intent` in metadata. The existing
loop-worker dispatch passes it through the same resolver before policy assessment;
checker and security-checker assignments never inherit maker instructions. Existing
agent-to-skill assignments, runtime admission and approval gates remain required.

`tools` is a requested selection bound, **not an authorization grant or a new
sandbox**. Registry actions must fit that request; omitted tools are not inferred.
CLI-internal tools are still governed by the existing runtime permissions, not
mediated per call by ToolBroker. This path adds no permission flags, credentials,
environment overrides, approval or production activation. Tests verify pinning,
revocation, changed bytes, input separation and six adapter input boundaries using
explicit approval fixtures; they do not demonstrate real promotion or provider use.

### Outcome identity and verification

New native skill executions persist nullable `capability_id`, `artifact_digest`
(the complete executable package), and `runtime` alongside the existing exact
`skill_version` and instruction `skill_content_hash`. Attribution uses the system
receipt created at dispatch, not a package reloaded after the worker finishes.
The additive migration deliberately leaves historical values NULL; no guessed
versions or runtime identities are backfilled. Missing usage stays NULL.

A hash-bound executable verification must explicitly report `status: passed`.
An absent verdict remains unknown; `status: failed` cannot become success merely
because its evidence severity is `info`. Candidate capture additionally checks
skill ID, instruction hash and executable package hash. Capture does not promote.

The runtime-intent tests use pre-approved SQLite fixtures. They demonstrate
selection, invocation and immutable reuse mechanics, not independent operational
promotion or causal improvement. The existing training/OpenMythos/baseline and
human-controlled gates remain mandatory for real activation.
