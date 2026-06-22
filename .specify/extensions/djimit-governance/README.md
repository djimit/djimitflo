# Djimit Governance Check Extension

A [Spec Kit](https://github.com/github/spec-kit) extension that validates
governance fields in generated artifacts, ensuring they comply with the
[djimit preset](../preset-djimit/) requirements.

## What it adds

| Command | Description |
|---------|-------------|
| `/speckit.djimit-governance.check` | Validates that plan.md and tasks.md contain required governance fields |

## Hooks

| Hook | Command | Optional | Description |
|------|---------|----------|-------------|
| `after_plan` | `speckit.djimit-governance.check` | yes | Prompts to run governance check after plan generation |
| `after_tasks` | `speckit.djimit-governance.check` | yes | Prompts to run governance check after task generation |

## What it validates

### Plan.md
- Security Impact section present and substantive
- Privacy Impact section present and substantive
- Threat Model Delta section present with mitigations
- Rollback Strategy section present

### Tasks.md
- Every task has a **Validation** field
- Every task has a **Rollback** field
- Every task has an **Execution Surface** field

### Constitution
- Runtime Awareness section present
- Security Baseline section present
- Library-First is NOT a mandatory/hard rule
- Approval gates are mentioned

## Installation

```bash
cd <your-project>
specify extension add --dev /Users/dlandman/SpecKit/extension-djimit-governance
```

## Verification

```bash
specify extension list
# Should show: Djimit Governance Check (v1.0.0) — Commands: 1 | Hooks: 2
```

## Usage

```bash
# After generating a plan
/speckit.djimit-governance.check

# Or run directly on a feature
/speckit.djimit-governance.check specs/001-my-feature
```

## Removal

```bash
specify extension remove djimit-governance
```
