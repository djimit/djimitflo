## Architecture

### Positioning

Pi becomes the **sovereign, local-model executor** in djimitflo's fan-out.
Where Codex/OpenCode bias toward hosted or vendor-locked runtimes, Pi's value is
that it runs on the workstation against local Ollama models with zero API egress,
and reads AGENTS.md natively. It does not displace the other executors; the
executor kind is chosen per task (Claude for complex refactors, Pi for
cost-amenable and confidentiality-sensitive local runs).

Pi is an external child process, invoked exactly like Codex/OpenCode:
`spawn(piPath, args, { cwd: worktree, env })`. No djimitflo code links against
Pi; there is no runtime dependency inside the control plane.

### Executor Contract Reuse

`PiExecutor` implements the existing `TaskExecutor` interface
(`kind`, `start`, `canExecute`) and returns an `ExecutionSession` with the
standard `events` (AsyncIterable) / `result` (Promise) / `cancel()` shape. It
reuses the proven Codex patterns:

- spawn + EventEmitter buffering (stdout/stderr lines),
- NDJSON parse with heuristic fallback + `EVIDENCE WARNING`,
- timeout SIGTERM→SIGKILL,
- security-override warning when permission bypass is active,
- mapping into the shared `ExecutionEventCreateInput` / `ExecutionEventType`
  / `LogLevel` model.

### Event Mapping (verified against Pi 0.79.8 — see docs/pi.md)

Pi emits NDJSON with its own schema (NOT Codex-style step-start/tool/text/step-finish).
The verified mapping:

| Pi event | djimitflo `ExecutionEventType` |
|---|---|
| `session` (header) | `LOG` (metadata: pi session id, cwd) |
| `agent_start` | `TASK_STARTED` |
| `turn_start` / `turn_end` | `LOG` (turn boundary; carry token usage to metrics) |
| `message_*` role=assistant (text deltas) | `LOG` (coalesce streaming) |
| `message_update` `toolcall_start`/`toolcall_end` | `TOOL_CALL` (`tool_name` from `toolCall.name`) |
| `tool_execution_start` | `TOOL_CALL` (execution phase) |
| `tool_execution_end` `isError:false` | `TOOL_RESULT` |
| `tool_execution_end` `isError:true` | `ERROR` (or `TOOL_RESULT` + error metadata) |
| message role=`toolResult` | `TOOL_RESULT` |
| `agent_end` (exit 0) | `TASK_COMPLETED` |
| non-JSON / stderr error line | heuristic `LOG`/`ERROR` + `EVIDENCE WARNING` |
| process exit != 0 | `TASK_FAILED` |

Token metrics come from the assistant `message.usage` (`input`, `output`,
`totalTokens`, `cost.total` — cost is 0 for local models). Because Pi always
emits valid JSON in `--mode json`, the heuristic fallback is a safety net for
stderr/process errors, not the expected path.

### Approval Source Of Truth (corrected)

Pi has **no permission popups and no `PI_SKIP_PERMISSIONS`** — it runs with the
launching user's permissions. There is nothing to bypass or pipe through
`approvalCallback`. djimitflo's policy engine is the **sole** boundary. Risk is
controlled by `--tools` allowlisting per task (drop `bash` for low-risk runs) and
by containerizing Pi for `bash`-enabled or sensitive-repo runs. File tools
(`read`/`ls`/`edit`/`write`) are cwd-scoped by default, which aligns naturally
with djimitflo worktree isolation; `bash` is the escape hatch and is treated as
high-risk. Sovereign runs MUST set `--offline`/`PI_OFFLINE=1`,
`PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` to prevent pi.dev startup egress.

### Sovereign Run Topology

```
djimitflo (MacBook/MacMini control) ──ssh──> workstation
   │ policy engine, approval gates, audit, diff/risk capture
   └─> PiExecutor spawns: pi <flags> --model <ollama-model> --dir <worktree>
                                          │
                                          └─> Ollama :11434 (local model)
                                              zero external API egress
```

The worktree is a `loop-*` / `agent/loop/` worktree; Pi's working-directory flag
is forced to it so file access stays scoped.

## Risks

- **Hypothetical CLI contract**: assumptions about flags / JSON output may not
  hold. Mitigation: Phase 0 is a hard gate; no implementation commits until
  evidence is captured, and the executor keeps the heuristic fallback.
- **Double approval**: Pi + djimitflo both gate. Mitigation: single source of
  truth (djimitflo), documented and tested in Phase 4.
- **Instruction precedence drift**: Pi could silently honor a project file over
  workspace governance. Mitigation: Phase 0 confirms load order; Phase 4 verifies.
- **Local-model nondeterminism**: `qwen3-coder:30b` is less stable than Claude.
  Mitigation: Pi runs are proposals/patches behind maker-checker + deterministic
  gates, not autonomous production mutation; the `validator` tier verifies.
- **Pi maturity**: rougher edges than Claude Code. Mitigation: Pi is one executor
  in the fan-out, selected by task type, never the sole path.

## Mitigations

- Evidence-first contract capture before any mapping is committed.
- Heuristic fallback retained so a missing JSON mode degrades gracefully.
- Hard gates (tests, lint, typecheck, secret scan, diff threshold) apply
  identically to Pi runs.
- Human approval required for auth, secrets, infra, policy, high-risk security,
  and deploy — unchanged by the executor choice.
- Audit trail records executor kind, instruction set in effect, and approval
  provenance for every Pi run.

## Rollback

Disable by unregistering `PiExecutor` and dropping `'pi'` from the three union
literals and `pi_path` from config. No other runtime code depends on Pi;
reverting is one executor file plus the small type/config additions. Existing
Codex/OpenCode/Claude/Gemini behavior is unchanged.
