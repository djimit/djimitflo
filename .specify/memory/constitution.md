<!--
Sync Impact Report
- Version change: 1.1.0 -> 1.2.0
- Modified principles: Added Article VI (DDD Semantic Layer)
- Added sections: Article VI - Domain-Driven Design, L8 Spec Compliance Gate
- Removed sections: none
- Templates requiring updates: spec-template.md (DDD artifact selection), tasks-template.md (DDD traceability)
- Follow-up TODOs: instantiate /specs folder structure in production project
-->

# Djimitflo Constitution

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

All implementation MUST follow strict Test-Driven Development. No implementation
code shall be written before:

1. Tests are written (Vitest for all packages)
2. Tests are validated and confirmed to FAIL (Red phase)
3. Implementation is written to make tests pass (Green phase)

This applies to `@djimitflo/server`, `@djimitflo/dashboard`, and `@djimitflo/shared`.
Contract tests MUST be written before integration code. Type safety (TypeScript
strict mode) is the first line of defense but does not replace runtime tests.

### II. Simplicity

Start simple, add complexity only when proven necessary. Maximum 3 packages for
initial feature implementation; additional packages require documented
justification. No speculative or "might need" features. Every feature must trace
back to a concrete user story with clear acceptance criteria.

Ponytail simplicity layer applies: prefer the smallest server/dashboard change
that preserves the control-plane contract. Do not add orchestration layers, agent
abstractions, route config, or scheduler state before an existing caller or test
proves the need.

### III. Anti-Abstraction

Use framework features directly rather than wrapping them. Single model
representation — do not create parallel type systems. No repository pattern
unless multiple data sources demonstrably require it. Express + SQLite directly;
React + Vite directly. Complexity must be justified in the plan's Complexity
Tracking section.

### IV. Monorepo Discipline

Features span packages by necessity, not by default. A feature that only affects
the dashboard MUST NOT touch server code unless it requires a new API endpoint.
Shared types go in `@djimitflo/shared` only when used by 2+ packages. Workspace
boundaries are enforced by `npm workspaces` and TypeScript project references.

### V. ESM and TypeScript Strict

All packages use `"type": "module"` and TypeScript strict mode. No CommonJS.
No `any` without explicit justification. Imports use explicit file extensions
in server code where required by Node ESM.


### VI. Domain-Driven Design (NON-NEGOTIABLE for Core subdomains)

Domain-Driven Design provides the semantic layer that eliminates three classes
of LLM hallucination in AI-generated code: Synonym Drift, Context Contamination,
and Invariant Violation. DDD artifacts are inviolable contracts.

#### VI.1 Ubiquitous Language Contract

Every Bounded Context SHALL have exactly one `domain-terms.md` file. Every
class, entity, value object, and command in generated code MUST have a 1:1
mapping to a term in the BC's domain-terms.md. Terms listed under
"Aliases to AVOID" are forbidden identifiers — use in code constitutes a
code review block. Naming a class `Manager`, `Service`, `Helper`, or
`Util` signals a missing glossary entry.

#### VI.2 Bounded Context Isolation

Aggregates from different Bounded Contexts SHALL NOT hold direct object
references to each other. Cross-BC references MUST use identity values
(e.g., `CustomerId`) resolved at the application layer. Cross-BC
communication SHALL use domain events or ACL-translated calls — never shared
database tables or direct imports between BC modules.

#### VI.3 Invariant Enforcement

Every aggregate classified as Core subdomain SHALL have an
`aggregate-{name}.md` specification. Invariants SHALL be written in EARS
notation (WHEN/IF/THEN/SHALL) — this extends L1 (Language Precision) to
business rules. Every invariant SHALL have at least one corresponding
validation in code and at least one test. Invariant specifications are input
for TLA+ formal verification where safety or liveness properties apply.

#### VI.4 Anti-Corruption Layer Mandate

Every external system integration (payment provider, CRM, ERP, SaaS API) SHALL
have an `acl-{system}.md` specification. The "Forbidden Concepts" section
is exhaustive — AI MUST NOT use external domain terms in core domain code. ACLs
SHALL translate external errors into domain exceptions.

#### VI.5 Artifact Selection per Change Type

| Change Type | Required DDD Artifacts |
|-------------|----------------------|
| Greenfield feature | domain-terms.md + bc-{name}.md + aggregate-{name}.md (if Core) + requirements.md |
| Brownfield refactor | bc-{name}.md (re-discover boundaries) + aggregate roots + acl if cutting legacy |
| External integration | context-map.md update + acl-{external}.md + events schema |
| Bug fix | UL discipline only |

#### VI.6 Human vs AI Artifact Ownership

| Artifact | Drafted By | Verified By |
|----------|-----------|-------------|
| domain-terms.md (UL) | Sub-agent extraction from requirements | Human reviews "Aliases to AVOID" |
| bc-{name}.md (BC Canvas) | Sub-agent | Human reviews "Business Decisions" + "Assumptions" |
| context-map.md | Sub-agent | Human reviews relationship patterns |
| aggregate-{name}.md | Human from scratch | Human - LLMs only consume |
| acl-{system}.md | Human from scratch | Human - LLMs only consume |

Rationale: FTAPI case study (arXiv 2603.26244, March 2026) shows LLMs are
effective at UL extraction, event identification, and BC boundary proposal
(strategic steps). They fail at aggregate design and technical architecture
mapping (tactical steps) through accumulated small errors.

#### VI.7 Spec-First Ordering

A pull request changing a DDD specification artifact MUST precede a pull request
changing the implementation that consumes it. Spec First L1 invariant: spec goes
first, code consumes it.

#### VI.8 Versioning and Migration

domain-terms.md terms are versioned alongside the spec. Renaming a term
requires: (1) update domain-terms.md, (2) add old term to "Aliases to AVOID",
(3) migration task in tasks.md, (4) grep codebase for old term usage. Breaking
changes to aggregate invariants require TLA+ re-verification.

## Runtime Awareness

This project runs on a multi-device workspace. The device-role matrix applies:

| Device | OS | Role | Locatie |
|--------|-----|------|---------|
| MacBook Pro M4 | Darwin | Cockpit: coding, research | Lokaal — direct exec |
| MacMini M2 | Darwin | Gateway: bots, schedulers | Remote — ssh macmini |
| Ubuntu Workstation | Linux | Execution: builds, containers | Remote — ssh workstation |

Rules:
- Spec Kit authoring (specify, plan, tasks, implement) runs on the MacBook.
- Any task requiring Docker, Ollama, or execution on a remote device MUST be
  marked with Execution Surface `ssh:<device>` or `docker:sandbox` and is
  approval-gated.
- `git status` checks run only locally (project repos are on MacBook/MacMini).
- No production-muterende acties without explicit user approval.

## Security Baseline

- Never log API keys, tokens, JWT secrets, or credentials in any output.
- Never read `auth.json`, `.env` files, or private keys unless explicitly
  permitted.
- Use `trash` above `rm` for file removal.
- No `git push` without explicit approval.
- Default-deny security policies: new endpoints MUST declare their auth
  requirement (admin/operator/viewer/public).
- All agent actions MUST produce audit trail entries with actor attribution.

## Scope Boundary

This constitution governs product-code features in the djimitflo sub-project only.

| Work type | System |
|-----------|--------|
| Infra, systemd, Docker, secrets, agents, production | OpenSpec only |
| Cross-cutting capability contracts (`~/openspec/specs/`) | OpenSpec only |
| Djimitflo product-code features (server, dashboard, shared) | Spec Kit (this constitution) |
| Skills/procedures | skill_workshop (unchanged) |
| Agent governance benchmarking | OpenMythos (reference-only, see Cross-System References) |

## Definition of Done

A feature is "done" only when ALL of the following hold:

1. **Tests pass**: All Vitest tests green on changed files; no regressions in full suite.
2. **Type safety**: `npm run type-check` passes with zero errors.
3. **Lint clean**: `npm run lint` passes with zero warnings.
4. **FR coverage**: Every FR-### in the spec has at least one implementing task and one test.
5. **Spec lifecycle**: Spec status transitions to `implemented`; changelog entry added.
6. **Constitution compliance**: No Article I–VI violations introduced.
7. **Audit evidence**: All gate evidence files written to `.swarm/evidence/`.

Reviewer MAY override items 4–5 with documented justification (see Specification Quality Gates).

## Specification Quality Gates

Every feature specification MUST contain seven information layers. These are
cross-cutting requirements — not sections, but qualities expressed in varying
proportion per spec.

| Layer | Name | Enforcement | Description |
|-------|------|-------------|-------------|
| L1 | Language Precision | CRITICAL | Functional requirements use EARS SHALL-format (FR-###). No ambiguity. |
| L2 | Negative Requirements | SHOULD | Non-Goals section + Forbidden Libraries list. What the feature does NOT do. |
| L3 | Measurable Criteria | CRITICAL | Success criteria with number + unit (SC-###). "Fast" is not measurable. |
| L4 | Hard Constraints | SHOULD | Tech stack versions, forbidden patterns, allowed/forbidden dependencies. |
| L5 | Codebase Anchoring | SHOULD | Each FR references specific file paths. No vacuum generation. |
| L6 | Edge Cases | CRITICAL | Named edge cases (EC-###) with IF-THEN scenarios. Happy path is not enough. |
| L7 | Verified Library Specs | SHOULD | Library name + version + key API constraints. No statistical guessing. |
| L8 | Spec Compliance | CRITICAL | DDD artifact compliance: UL names, invariant coverage, ACL boundary, cross-BC isolation. |

**Enforcement levels:**
- **CRITICAL**: Hard gate. Plan generation blocked until satisfied. Mechanically verifiable.
- **SHOULD**: Soft gate. Reviewer MAY override with documented justification.
- **MAY**: Advisory. Best effort.

**Ratchet policy:** After 90 days, evaluate override rates. If SHOULD override
rate is below 10% across all layers, escalate to CRITICAL. If override rate is
above 10%, improve template clarity before escalating.

## Cross-System Governance References

### OpenMythos Agent Governance

OpenMythos (`~/OpenMythos/`) defines an evolutionary agent governance benchmark
with 11 risk categories and 342 test cases. It applies to all agent-facing code
paths in DjimFlo.

| Integration Point | Trigger | Scope |
|---|---|---|
| Pre-plan gate | New feature spec generated | 78-case subset (hierarchy + injection + tool-scope) |
| Model promotion | Model configuration change | Full 342-case run + McNemar test vs baseline |

OpenMythos is reference-only — it does not replace this constitution. The
constitution defines WHAT is governed; OpenMythos defines HOW agents are
evaluated against governance categories.

### OpenSpec Infrastructure Governance

OpenSpec (`~/openspec/`) governs cross-cutting infrastructure concerns:
Docker, systemd, secrets, production deployments, and capability contracts.
When an OpenSpec change modifies a capability contract that DjimFlo consumes,
the OpenSpec change supersedes this constitution for that specific interface.

## Governance

This constitution supersedes all other practices for djimitflo product-code
features. Amendments require:

- Explicit documentation of the rationale for change.
- Review and approval by the project maintainer.
- Backwards compatibility assessment.
- Version increment per semantic versioning (MAJOR: principle
  removal/redefinition; MINOR: new principle/section; PATCH: clarification).

**Version**: 1.2.0 | **Ratified**: 2026-06-22 | **Last Amended**: 2026-07-24
