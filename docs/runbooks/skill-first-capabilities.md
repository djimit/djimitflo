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
a version; selecting the previous approved version is rollback.

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
never grant additional privileges. Assign skills to agents through the existing
assignment interface when agent attribution is used. Execution rechecks current
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
