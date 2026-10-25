<!-- generated — do not edit. Source: docs/usage-plan-limits.json, packages/server/src/execution/runtime-admission.ts, packages/server/src/services/evolution-evidence.ts (EVOLUTION_FLAGS), docs/runbooks/self-improvement-loop-operations.md. Regenerate: node scripts/gen-agent-docs.mjs -->

# TOOLS — accounts, runtimes, inference flags

What agents can use and under which limits. Facts only; a missing number stays "not published" (never invent one).

## Accounts and active plans

| Account | Active plan | Window | Limit |
|---|---|---|---|
| ollama_cloud | Legacy Max (pre-2026-08-31) | session | no published number: the session and weekly limits of the old plans no longer apply [after switching]; numbers not published |
| ollama_cloud | Legacy Max (pre-2026-08-31) | weekly | no published number: the session and weekly limits of the old plans no longer apply [after switching]; numbers not published |
| claude_max | Max 5x ($100/mo) | 5h | no published number: Max 5x includes five times the Pro plan's per-session usage allowance. Your session-based usage limit will re… |
| claude_max | Max 5x ($100/mo) | weekly | no published number: Max plans also have a weekly usage limit that applies across all models. The weekly limit resets at a fixed t… |
| chatgpt_pro | Pro $100/mo (Codex & Work) | 5h | no published number: Pro plans currently have no five-hour limit. |
| chatgpt_pro | Pro $100/mo (Codex & Work) | weekly | no published number: Local messages and cloud chats share your plan's usage allowance. Weekly limits may also apply. |
| opencode_free | unknown (4 candidate plan row(s) in the source) | — | — |
| typesafe_jev | unknown (1 candidate plan row(s) in the source) | — | — |
| nvidia | unknown (1 candidate plan row(s) in the source) | — | — |
| local_workstation | unknown (0 candidate plan row(s) in the source) | — | — |

## Runtimes (admission ledger)

A registered runtime is not an admitted one; the decision per version is in `GET /api/health/runtimes`.

| Runtime | Pinned version | Record | Expires |
|---|---|---|---|
| opencode | 1.18.10 | legacy | 2026-12-31 |
| atomic | 0.6.5 | legacy | 2026-12-31 |
| codex | 0.146.0 | legacy | 2026-12-31 |
| claude | 2.1.282 | legacy | 2026-12-31 |
| remote | not bound | legacy | 2026-12-31 |
| mock | not bound | legacy | 2026-12-31 |
| hermes | not bound | legacy | 2026-12-31 |
| gemini | not bound | legacy | 2026-12-31 |
| editor | not bound | legacy | 2026-12-31 |
| pi | not bound | legacy | 2026-12-31 |
| deep-agent | not bound | legacy | 2026-12-31 |
| openhuman | not bound | assessed | 2027-04-01 |

## Inference and failover flags

From EVOLUTION_FLAGS; default as in the runbook flag table (docs/runbooks/self-improvement-loop-operations.md).

| Flag | Acting | Default |
|---|---|---|
| `MODEL_SELECTOR_MODE` | yes | off (`shadow` samples a cheaper candidate per panel review and discards it; `enforce` use… |
| `SUBSCRIPTION_GYM_SPECIES` | yes | `''` = off (`claude`, `codex`, `opencode-free:<model>`, comma-separated, e.g. `claude,cod… |
| `SUBSCRIPTION_GYM_MAX_PER_DAY` | yes | 5 |
| `SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS` | yes | 18000000 (5 h) |
| `OLLAMA_OUTAGE_FALLBACK_RUNTIME` | yes | unset = off (`claude`) |
| `OLLAMA_AUTO_FAILOVER` | yes | off (`on`) |
| `OLLAMA_FAILOVER_PROBE_MODEL` | yes | unset = cheapest `MODEL_COST_WEIGHTS` name + `:cloud` (default `glm-5.3-flash:cloud`) |
| `PANEL_FALLBACK_RUNTIME` | yes | off (`claude`) |
| `PANEL_FALLBACK_MODEL` | yes | `haiku` |
| `INFERENCE_BUDGET_THROTTLE` | yes | `shadow` (`off`, `on`) |
| `OLLAMA_WEEKLY_TOKEN_BUDGET` | yes | unset = no budget (never throttles) |
| `OLLAMA_THROTTLE_AT` | yes | 0.7 |
| `OLLAMA_BALANCE_MODE` | no | off (`on`) |
| `OLLAMA_ACCOUNT_KEY_ENV` | no | `SOCIAL_COMPAT_API_KEY` |

## Fixed rules

- Production reads are read-only probes: a small `better-sqlite3` script opened with `{ readonly: true }`, copied into the
  container and run with `docker exec … node` (runbook "Read-only probes"). Never write to the prod DB, never run branch code there.
- Merging goes only through `scripts/merge-train.sh` (or a chain of it) with a pinned head (`<pr>@<headsha>`); agents never merge.
- Sandbox caveat: codex runs its sandbox through bubblewrap, which cannot run inside the production container.
