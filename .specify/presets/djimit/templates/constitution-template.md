# [PROJECT_NAME] Constitution

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

All implementation MUST follow strict Test-Driven Development. No implementation
code shall be written before:

1. Tests are written
2. Tests are validated and confirmed to FAIL (Red phase)
3. Implementation is written to make tests pass (Green phase)

Contract tests MUST be written before integration code. This principle applies
to all project types — libraries, servers, UIs, CLIs, mobile apps.

### II. Simplicity

Start simple, add complexity only when proven necessary. No speculative or
"might need" features. Every feature must trace back to a concrete user story
with clear acceptance criteria. Additional projects/packages require documented
justification.

### III. Anti-Abstraction

Use framework features directly rather than wrapping them. Single model
representation — do not create parallel type systems. Complexity must be
justified in the plan's Complexity Tracking section.

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

- Never log API keys, tokens, or credentials in any output.
- Never read `auth.json`, `.env` files, or private keys unless explicitly
  permitted.
- Use `trash` above `rm` for file removal.
- No `git push` without explicit approval.

## Scope Boundary

[PROJECT_SCOPE_BOUNDARY — e.g., "This constitution governs product-code features
in the <project-name> sub-project only."]

| Work type | System |
|-----------|--------|
| Infra, systemd, Docker, secrets, agents, production | OpenSpec only |
| Cross-cutting capability contracts (`~/openspec/specs/`) | OpenSpec only |
| Product-code features in this sub-project | Spec Kit (this constitution) |
| Skills/procedures | skill_workshop (unchanged) |

## Governance

This constitution supersedes all other practices for product-code features in
this sub-project. Amendments require:

- Explicit documentation of the rationale for change.
- Review and approval by the project maintainer.
- Backwards compatibility assessment.
- Version increment per semantic versioning (MAJOR: principle
  removal/redefinition; MINOR: new principle/section; PATCH: clarification).

**Version**: [CONSTITUTION_VERSION] | **Ratified**: [RATIFICATION_DATE] | **Last Amended**: [LAST_AMENDED_DATE]
