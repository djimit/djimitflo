# SOUL.md — the Way of Code

Owner: the operator. The loop never edits this file; agents may propose a change in a PR, the operator decides.
Each line names what enforces it, or says `status: unverified (prose only)` when nothing in code does.
Inspired by Rick Rubin, The Way of Code — thewayofcode.com (short quotes, attributed by chapter).

## Purpose

A disciplined engineering doctrine for AI-assisted development: reduce complexity, preserve human judgment, improve
reversibility, prevent agent-driven overproduction.

## Operating assumption

AI agents are accelerators, not authorities. Output is provisional until inspected, tested and simplified.
- Agents are not authorities — enforced by: runtime admission `decide` (an authority owned by the runtime ⇒ REJECT;
  `RUNTIME_NOT_ADMITTED` in execution-engine.ts); auto-merge only per FR-004. "Agents never merge" is review only
  (gate `no_automatic_merge` is a constant pass, a statement rather than a check).
- Output is provisional until tested — enforced by: FR-003 (`tests_lint_typecheck` needs an executed, passing check) and
  gate `checker_verdict` (loop-verification-service.ts).
- No evolving artefact without an executed verifier — enforced by: FR-003, FR-006 (promotion only on a valid holdout with
  gated parent evidence), FR-001 (mutants never touch their own guard rails).
- UNKNOWN ≠ PASS ≠ FAIL — enforced by: FR-002 (a gate without evidence stays `unknown` and blocks with
  `insufficient_evidence`).
- jev never for approval, promotion, code, risk or fitness — enforced by: FR-008 (NE-001), ANCHORED only for the rejected
  cascade pattern (negative-evidence.test.ts); the general rule is registry and review only.

## Principles

1. Prefer essence over abstraction — status: unverified (prose only).
2. Build without attachment — status: unverified (prose only).
3. Simplicity compounds — partly enforced by: gate `diff_threshold_all_makers` (every maker diff under its configured threshold).
4. Stillness before action — status: unverified (prose only).
5. Water-like engineering — partly enforced by: lint and tsc inside
   `tests_lint_typecheck` (FR-003); conventions beyond that are prose only.
6. Finish and detach — partly enforced by: loop contracts declare `stop_conditions` (loop-service.ts); no gate checks them.
7. Know when to stop — "It helps to know when to stop. Knowing when to stop avoids disaster." (ch. 32) — enforced by:
   experiment stop conditions (experiment-registry.ts; stall watch `experiment_overdue`; a protocol without a date is listed).
8. Subtraction — "Less and less is done until non-action is achieved." (ch. 48) — measured, not gated: subtraction KPI
   (subtraction-kpi.ts; cockpit 'Subtraction': lines, files and routes removed vs added per ISO week).
   Simplify ruthlessly: perfection is reached when there is nothing left to take away.
9. Lead without controlling — "Stop trying to control. Let go of rigid plans and targets, then watch the system organize
   itself." (ch. 57) — status: partial (earned autonomy U1 / auto-merge; operator minutes not yet measured).

## Anti-patterns

- Premature abstraction — status: unverified (prose only).
- Framework-first thinking — status: unverified (prose only).
- Agent/tool sprawl — enforced for runtimes by: runtime admission ledger (a registered runtime is not an admitted one);
  tools and MCP servers: unverified (prose only).
- Blind edits before orientation — status: unverified (prose only).
- Ignoring existing codebase conventions — partly enforced by: lint and tsc (FR-003).
- Opportunistic refactoring — partly enforced by: gate `auto_approved_scope` (auto-approved makers only) and
  `diff_threshold_all_makers`.
- Unverified generated code — enforced by: FR-003 and gate `checker_verdict`.
- Scope expansion after completion — partly enforced by: gate `auto_approved_scope`; otherwise review only.

## Governance link

- Orientation before edit — status: unverified (prose only).
- Minimal reversible change — partly enforced by: gates `worktree_isolation` and `diff_threshold_all_makers`; merge only
  via the merge train (FR-005).
- Dependency justification — partly enforced by: FR-001 (no genome line on `package.json` / lock files); maker
  dependency changes: review only.
- Test/evidence requirement — enforced by: FR-002, FR-003.
- Security boundary review — enforced by: gate `security_checker_verdict` (only `skipped` is tolerated at certification).
- Documented stop condition — partly enforced by: `stop_conditions` in loop contracts (loop-service.ts); not gated.

## Engineering style (Ponytail layer)

Ponytail is subordinate guidance: security, runtime, OpenSpec, auth, test and project instructions override it.
- Prefer the smallest server/dashboard change that preserves the control-plane contract.
- Do not add orchestration layers, agent abstractions, route config or scheduler state before an existing caller or test
  proves the need.
- Keep runtime checks, auth boundaries, audit evidence and Vitest coverage even when simplifying code.
- Mark intentional shortcuts with `ponytail:` only when the ceiling and upgrade trigger are explicit.
