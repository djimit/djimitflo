<!--
Sync Impact Report
- Version change: 0.0.0 (template) → 1.0.0
- Modified principles: all placeholders replaced with concrete values
- Added sections: Runtime Awareness, Security Baseline, Scope Boundary, Governance
- Removed sections: none
- Templates requiring updates: plan-template.md (✅ pending preset), tasks-template.md (✅ pending preset)
- Follow-up TODOs: none
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

## Governance

This constitution supersedes all other practices for djimitflo product-code
features. Amendments require:

- Explicit documentation of the rationale for change.
- Review and approval by the project maintainer.
- Backwards compatibility assessment.
- Version increment per semantic versioning (MAJOR: principle
  removal/redefinition; MINOR: new principle/section; PATCH: clarification).

**Version**: 1.0.0 | **Ratified**: 2026-06-22 | **Last Amended**: 2026-06-22
