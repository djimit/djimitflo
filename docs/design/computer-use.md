# Design: computer use as a governed Djimitflo executor (plan E5)

Status: design, 2026-09-24. No code yet. Implementation behind `COMPUTER_USE_ENABLED` (default off).

## Principle

Computer use is a new **executor kind** behind the existing gates (approval, evidence, audit, budget) — never a side
channel. The model looks at screenshots and asks for actions; Djimitflo decides whether an action runs, runs it inside an
isolated sandbox, and records every step as evidence.

## What exists (reuse)

- `TaskExecutor` interface (`execution/types.ts`) with executors per runtime (claude, codex, gemini, opencode, hermes, …).
- `DockerSandboxExecutor` (`execution/executors/docker-sandbox-executor.ts`): containers with `--cap-drop` and a
  configurable `--network` mode — the isolation boundary to extend.
- Approval policies, audit trail, evidence store, per-run budgets, the loop's one-approval-per-run model.

## Provider facts to design against (verify again at the spike)

**Claude** (Anthropic docs, current as of 2026-09):
- Current form: the **computer toolset** `{"type": "computer_toolset_20260801"}` — GA on the Claude API and Google Cloud,
  no beta header, no `name`, no display size; optional `configs` to switch members off (e.g. `{"zoom": {"enabled": false}}`).
  17 members (`screenshot`, `left_click`, `type`, `zoom`, …) are on by default.
- The model's calls are `tool_use` blocks whose **`name` is the action**, with `"toolset_name": "computer"`; several can
  arrive in one turn. Every `tool_result` must echo `"toolset_name": "computer"`; only `screenshot`/`zoom` return an image,
  the rest a short `OK`. Coordinates are in the pixel space of the screenshots we return; screenshots must already fit the
  model's image limits (the API does not downscale). ~1080p screenshots are a good accuracy/cost balance.
- Older form `computer_20251124` (beta `computer-use-2025-11-24`) still exists on some models/platforms; Claude Opus 5.5
  accepts only the toolset. Target the toolset.
- Client-side: we host and run the environment; Anthropic processes screenshots and actions but does not host the desktop.

**OpenAI / Gemini:** both offer computer-use style tools (Gemini's `computer-use-preview` already runs on the workstation
with Chrome + Playwright). Exact tool names, action sets, pricing and limits are **not** asserted here — they are to be
read from the current provider docs at the start of the spike, not from memory.

## Architecture

```
loop run / work item ──► ComputerUseExecutor (TaskExecutor) ──► provider adapter (claude | openai | gemini)
                                    │                                   ▲ screenshot        │ action(s)
                                    ▼                                   │                   ▼
                          sandbox: DockerSandboxExecutor extension ─ Xvfb + Chromium + Playwright (non-root)
                                    │
                                    └─► evidence: one screenshot + action record per step; audit event per session
```

- **One loop** in Djimitflo: screenshot → model → action(s) → policy check → execute in sandbox → screenshot. Provider
  adapters only translate request/response shapes.
- **Sandbox:** extend the Docker executor with a desktop image (Xvfb + Chromium + Playwright), non-root, `--cap-drop ALL`,
  no host mounts, **no credentials inside**, network via an **allowlist** proxy (not `none`, not open).
- **Policy check per action** (in code, before execution): domain allowlist for navigation; block typing into password and
  payment fields, file downloads, accepting terms, and anything outside the allowlist; max steps / wall time / cost per
  session; a kill switch that ends the session immediately.
- **Prompt-injection rule:** page text is data, never an instruction. The system prompt says so; the policy layer is the
  real boundary. A TypeSafe guardrail on page text (ADR 0002) may be an extra layer, never the boundary.

## Guardrails (mandatory)

- `COMPUTER_USE_ENABLED` default off; every session is a high-risk action and needs a human approval.
- Budget per session (steps, minutes, provider tokens/cost) enforced by the executor, not the model.
- Evidence: a screenshot per step in the evidence store, the action list, the policy decisions, the final outcome.
- No passwords, payment data or personal accounts; test accounts only, provided by the operator.

## First use case (read-only dogfood)

UI-QA of Djimitflo's own dashboard on production with a test account: open the pages (Approvals, Funnel, Commons,
Explainers), check that key elements render and numbers are plausible, report findings as work items. This replaces the
manual browser checks of the feature matrix (plan E4) and is read-only.

## Spike plan and stop-points

1. Claude first (toolset, API key already in the ecosystem): 5 fixed read-only tasks on the dashboard in the sandbox.
2. Gemini next (existing `computer-use-preview` on the workstation), then OpenAI once the operator provides a key.
3. Compare per provider: success rate, steps and cost per task, latency → a provider routing table (with the LLM failover).

**Operator decisions before the spike:** provider API keys, a test account for the dashboard, the domain allowlist, and the
per-session budget.
