# Changelog — Djimit Governance Bridge Preset

## 1.0.0 — 2026-06-22

### Added
- `plan-template` override (append): Security Impact, Privacy Impact, Threat
  Model Delta, Rollback Strategy sections injected into plan template.
- `tasks-template` override (append): per-task Validation, Rollback, Execution
  Surface fields injected into tasks template.
- `constitution-template` override (replace): governance-ready constitution
  template with Runtime Awareness (device-role matrix), Security Baseline,
  Scope Boundary sections. Relaxes Library-First and CLI Interface articles.
- `speckit.implement` command override (wrap): approval-gate preamble that
  blocks `ssh:*`, `docker:*`, and production-touching tasks pending explicit
  user approval. Uses `{CORE_TEMPLATE}` placeholder for core implement logic.

### Known limitations
- `specify preset add --dev <path>` requires the source directory to be
  outside `.specify/presets/` in the target project (the installer deletes
  the destination before copying from the source).
- Core command templates (`templates/commands/*.md`) must be manually copied
  to `.specify/templates/commands/` in the target project for the `wrap`
  composition strategy to resolve. This is a Spec Kit v0.11.3 limitation —
  `specify init` does not copy command templates to `.specify/templates/commands/`,
  only to the agent directory (e.g., `.opencode/commands/`).

### Workaround installation
```bash
# 1. Install the preset from this persistent location
cd <your-project>
specify preset add --dev /Users/dlandman/SpecKit/preset-djimit

# 2. Copy core command templates (needed for wrap strategy)
mkdir -p .specify/templates/commands
cp /Users/dlandman/SpecKit/spec-kit-src/templates/commands/*.md .specify/templates/commands/
```
