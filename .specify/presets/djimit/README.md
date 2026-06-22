# Djimit Governance Bridge Preset

A [Spec Kit](https://github.com/github/spec-kit) preset that injects OpenSpec
governance fields into Spec Kit templates, bridging Spec Kit's SDD pipeline with
Dennis's existing OpenSpec change-control system.

## What it does

| Override | Strategy | Effect |
|----------|----------|--------|
| `plan-template` | append | Adds Security Impact, Privacy Impact, Threat Model Delta, Rollback Strategy sections to every generated plan |
| `tasks-template` | append | Adds per-task Validation, Rollback, Execution Surface fields to every generated task list |
| `constitution-template` | replace | Replaces the default 9-article constitution with a governance-ready template: Runtime Awareness (device-role matrix), Security Baseline, Scope Boundary. Relaxes Library-First and CLI Interface. Keeps Test-First, Simplicity, Anti-Abstraction. |
| `speckit.implement` | wrap | Wraps the implement command with an approval-gate preamble that blocks `ssh:*`, `docker:*`, and production tasks pending explicit user approval |

## Scope boundary

This preset is for **product-code features in sub-projects** only.

| Work type | System |
|-----------|--------|
| Infra, systemd, Docker, secrets, agents, production | OpenSpec only |
| Cross-cutting capability contracts | OpenSpec only |
| Product-code features in a sub-project | Spec Kit (with this preset) |
| Skills/procedures | skill_workshop (unchanged) |

## Installation

### Prerequisites

- Spec Kit CLI v0.11.0+ (`uv tool install specify-cli`)
- An initialized Spec Kit project (`specify init --here --integration opencode`)

### Install the preset

```bash
cd <your-project>
specify preset add --dev /Users/dlandman/SpecKit/preset-djimit
```

### Required workaround: copy core command templates

Spec Kit v0.11.3 does not copy command templates to `.specify/templates/commands/`
during `specify init` — it installs them directly to the agent directory. The
`wrap` composition strategy for `speckit.implement` needs the core command as a
base layer to compose onto. Without this copy, the implement wrapper won't
register.

```bash
mkdir -p .specify/templates/commands
cp /Users/dlandman/SpecKit/spec-kit-src/templates/commands/*.md .specify/templates/commands/
```

If you don't need the implement approval-gate wrapper, you can skip this step
and remove the `speckit.implement` command override from `preset.yml`.

### Verify installation

```bash
specify preset list                                    # should show djimit
specify preset resolve plan-template                   # should show composition chain
specify preset resolve tasks-template                  # should show composition chain
specify preset resolve constitution-template           # should show djimit as top layer
```

## Removal

```bash
specify preset remove djimit
```

This restores the next-priority templates automatically (core defaults).

## Structure

```text
preset-djimit/
├── preset.yml                          # Manifest
├── README.md                           # This file
├── LICENSE                             # MIT
├── CHANGELOG.md                        # Version history
├── templates/
│   ├── plan-template.md                # Append: governance sections
│   ├── tasks-template.md               # Append: per-task governance fields
│   └── constitution-template.md        # Replace: governance-ready constitution
└── commands/
    └── speckit.implement.md            # Wrap: approval-gate preamble
```

## Governance fields injected

### Plan template (appended)

- **Security Impact** — what attack surface the feature introduces/expands
- **Privacy Impact** — what user/engagement data is generated or exposed
- **Threat Model Delta** — new threat vectors and their mitigations
- **Rollback Strategy** — how to undo the feature's changes

### Tasks template (appended)

Each task MUST include:
- **Validation** — how to verify the task succeeded
- **Rollback** — command to undo the task's changes
- **Execution Surface** — `host:macbook`, `ssh:<device>`, or `docker:sandbox`

### Constitution template (replaced)

- Runtime Awareness (device-role matrix, local-vs-remote exec)
- Security Baseline (never log secrets, trash over rm, no push without approval)
- Scope Boundary (Spec Kit for product-code, OpenSpec for infra/ops)
- Relaxed Library-First and CLI Interface articles
- Kept Test-First, Simplicity, Anti-Abstraction

### Implement command (wrapped)

Preamble that:
1. Reads tasks.md and scans every task for Execution Surface
2. Blocks `ssh:*` and `docker:*` tasks pending explicit user approval
3. Blocks production-touching tasks pending explicit user approval
4. Checks security baseline (no secret logging, no .env reading, trash over rm)
5. After gate passes, proceeds to core implement workflow
