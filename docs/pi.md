# Pi Executor — CLI Contract (Phase 0 Evidence)

> Captured 2026-06-20 on the Ubuntu workstation against a live Pi binary.
> Pi version: **0.79.8** (`@earendil-works/pi-coding-agent`).
> Install: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
> (Node >=22.19.0; workstation has v22.23.0). Binary: `~/.npm-global/bin/pi`.

Pi is a **TypeScript/Node** terminal coding harness (author: Mario Zechner /
badlogic). Minimal core; extensibility via TypeScript extensions, skills, prompt
templates, themes, and pi packages. **No built-in permissions, no MCP, no
sub-agents, no plan mode** — by design.

## Invocation modes (the executor seam)

| Flag | Use for djimitflo |
|------|-------------------|
| `-p`, `--print` | One-shot: process prompt and exit. Reads piped stdin merged into prompt. |
| `--mode json` | **Primary executor mode.** Streams all session events as NDJSON to stdout. |
| `--mode rpc` | Bidirectional JSONL over stdin/stdout for process integration (prompt/steer/follow_up/abort/get_state). Alternative to CLI spawn. |
| (default) | Interactive TUI — not used by the executor. |

djimitflo spawns `pi --mode json -p …` as a child process, identical to the
Codex/OpenCode pattern. RPC mode is a future option if djimitflo needs to inject
steering messages mid-run.

## CLI flags relevant to the executor

```
pi [options] [@files...] [messages...]
--provider <name>            # e.g. ollama (custom), anthropic, openai
--model <pattern>             # "provider/id" or id; optional ":<thinking>"
--api-key <key>              # overrides env vars
--mode <mode>                # text | json | rpc
--print, -p                  # non-interactive
--no-session                 # ephemeral (don't persist session JSONL)
--session-dir <dir>          # custom session storage
--tools, -t <list>           # allowlist tool names
--exclude-tools, -xt <list>  # denylist tool names
--no-builtin-tools, -nbt     # disable built-in tools, keep extension tools
--no-tools, -nt              # disable all tools
--no-context-files, -nc      # disable AGENTS.md / CLAUDE.md discovery
--no-extensions, -ne         # disable extension discovery
--no-skills, -ns             # disable skill discovery
--system-prompt <text>       # replace default system prompt
--append-system-prompt <text># append to system prompt
--approve, -a                # trust project-local files for this run
--no-approve, -na            # ignore project-local files for this run
--offline                    # disable startup network ops (same as PI_OFFLINE=1)
--thinking <level>           # off|minimal|low|medium|high|xhigh
```

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

## Sovereign local-model configuration (zero API egress)

Custom OpenAI-compatible providers via `~/.pi/agent/models.json`. Ollama config
verified live on the workstation:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        { "id": "llama3.1:8b", "reasoning": false },
        { "id": "qwen2.5-coder:7b", "reasoning": false },
        { "id": "qwen3-coder:30b-a3b-q4_K_M", "reasoning": false }
      ]
    }
  }
}
```

Verified `pi --list-models` lists the ollama models. Smoke run completed against
`ollama/llama3.1:8b` with **zero external egress** (model served from
`localhost:11434`, Pi started with `--offline`).

**Egress hygiene for sovereign runs (mandatory):** Pi contacts `pi.dev` at
startup for version check + install telemetry unless disabled. Set all three:
`--offline` (or `PI_OFFLINE=1`), `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`
(also `enableInstallTelemetry: false` in settings.json). Without these the
"zero egress" success criterion is NOT met.

## NDJSON event schema (captured live)

First line is a session header, then events. Schema from
`AgentSessionEvent` / `AgentEvent`:

```
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user"|"assistant"|"toolResult",...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{...}}   # streaming deltas
{"type":"message_end","message":{...}}
{"type":"tool_execution_start","toolCallId":"...","toolName":"ls","args":{...}}
{"type":"tool_execution_end","toolCallId":"...","toolName":"ls","result":{"content":[{"type":"text","text":"..."}]},"isError":false}
{"type":"turn_end","message":{...},"toolResults":[...]}
{"type":"agent_end","messages":[...]}
# also: queue_update, compaction_start/end, auto_retry_start/end
```

`assistantMessageEvent` sub-types observed: `text_start`, `text_delta`,
`toolcall_start`, `toolcall_delta`, `toolcall_end`. Each assistant message
carries `usage` (`input`, `output`, `totalTokens`, `cost`) — source for the
executor's token metrics.

### Live sample (zero-egress ollama/llama3.1:8b, trimmed to canonical lines)

```json
{"type":"session","version":3,"id":"019ee5dc-...","timestamp":"2026-06-20T16:28:43.354Z","cwd":"/tmp/pi-smoke"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Use the ls tool ..."}]}}
{"type":"message_end","message":{"role":"user",...}}
{"type":"message_start","message":{"role":"assistant","content":[],"provider":"ollama","model":"llama3.1:8b","usage":{"input":0,"output":0,"totalTokens":0,"cost":{"total":0}},"stopReason":"stop"}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"partial":{...toolCall id:"call_mgnpzvey", name:"ls", arguments:{...}}}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"call_mgnpzvey","name":"ls","arguments":{...}}}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_mgnpzvey","name":"ls",...}],"usage":{"input":788,"output":55,"totalTokens":843},"stopReason":"toolUse"}}
{"type":"tool_execution_start","toolCallId":"call_mgnpzvey","toolName":"ls","args":{"limit":"null","path":"/"}}
{"type":"tool_execution_end","toolCallId":"call_mgnpzvey","toolName":"ls","result":{"content":[{"type":"text","text":"Validation failed for tool \"ls\":\n  - limit: must be number\n..."}]},"isError":true}
{"type":"message_start","message":{"role":"toolResult","toolCallId":"call_mgnpzvey","toolName":"ls","content":[{"type":"text","text":"Validation failed ..."}],"isError":true}}
{"type":"turn_end","message":{...assistant...},"toolResults":[{...toolResult...}]}
{"type":"turn_start"}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Validation"}}
...
{"type":"agent_end","messages":[...]}
```

Full raw sample archived in the change evidence (run reproducible with the
command below).

### Reproduce

```bash
ssh workstation
export PATH=~/.npm-global/bin:$PATH PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1
cd /tmp && rm -rf pi-smoke && mkdir pi-smoke && cd pi-smoke && echo "hello world" > greet.txt
pi --mode json -p --offline --no-session --no-approve --no-context-files \
   --no-extensions --no-skills --provider ollama --model llama3.1:8b \
   --tools read,ls "Use the ls tool to list files, then read greet.txt."
```

## djimitflo event mapping (concrete, replaces the Codex-style assumption)

| Pi event | djimitflo `ExecutionEventType` |
|---|---|
| `session` (header) | `LOG` (metadata: pi session id, cwd) |
| `agent_start` | `TASK_STARTED` |
| `turn_start` | `LOG` (turn boundary) |
| `message_start`/`message_end` role=assistant | `LOG` |
| `message_update` `text_delta`/`text_start` | `LOG` (optional streaming; can coalesce) |
| `message_update` `toolcall_start`/`toolcall_end` | `TOOL_CALL` (`tool_name` from `toolCall.name`, args in metadata) |
| `tool_execution_start` | `TOOL_CALL` (execution phase) |
| `tool_execution_end` `isError:false` | `TOOL_RESULT` |
| `tool_execution_end` `isError:true` | `ERROR` (or `TOOL_RESULT` + error metadata) |
| message role=toolResult | `TOOL_RESULT` |
| `turn_end` | `LOG` (carry token usage to metrics) |
| `agent_end` | `TASK_COMPLETED` (exit 0) |
| non-JSON / stderr error line | heuristic `LOG`/`ERROR` + `EVIDENCE WARNING` |
| process exit != 0 | `TASK_FAILED` |

Token metrics: read `message.usage.totalTokens` / `input` / `output` from the
final assistant `message_end` or `turn_end`; `cost.total` is 0 for local models.

## Security findings (correct earlier assumptions)

1. **No permission popups, no `PI_SKIP_PERMISSIONS`.** Pi has no built-in
   permission system — it runs with the launching user's permissions. There is
   nothing to bypass or pipe through `approvalCallback`. **djimitflo's policy
   engine is the sole boundary.** Use `--tools` allowlisting to restrict
   capability per task (e.g. `--tools read,edit,write` without `bash` for
   low-risk runs).

2. **File tools are cwd-scoped by default.** `read`/`ls`/`edit`/`write` reject
   paths outside the working directory ("path should start with /tmp/pi-smoke/").
   This is a useful default sandbox for djimitflo worktree runs. **`bash` is the
   escape hatch** — it runs with full user perms. Treat any task allowing `bash`
   as high-risk and require djimitflo approval + (recommended) containerization.

3. **Containerization recommended for untrusted/high-risk work.** Pi docs list
   three patterns: Gondolin extension (host auth, tools in micro-VM), plain
   Docker, OpenShell policy sandbox. djimitflo should containerize Pi for runs
   that allow `bash` or operate on sensitive repos (Rechtspraak).

4. **Project trust.** Non-interactive modes (`-p`, `--mode json`, `--mode rpc`)
   do not prompt. Pass `--no-approve`/`-na` to ignore project-local `.pi`
   settings/extensions/skills (avoids executing arbitrary project extension
   code) while **still loading AGENTS.md context files** (context files load
   before/without trust). Use `-na` for deterministic executor runs.

5. **Telemetry egress.** See "Egress hygiene" above. Mandatory for sovereign runs.

## Instruction precedence (AGENTS.md)

Pi loads `AGENTS.md` (or `CLAUDE.md`) from: `~/.pi/agent/AGENTS.md` (global),
parent directories walking up from cwd, and current directory. All matching
files are **concatenated**. Disable with `--no-context-files`/`-nc`.

djimitflo enforcement: let Pi load workspace + project AGENTS.md natively
(matches the DjimIT precedence: workspace > project), and inject the djimitflo
task via the prompt / `--append-system-prompt`. If djimitflo must be the sole
source, use `-nc` and pass everything via `--system-prompt` /
`--append-system-prompt`. The audit trail must record which instruction set was
in effect (context files on vs `-nc`).

## Open questions resolved by this capture

- Headless invocation: `--mode json -p` (or `--mode rpc`). RESOLVED.
- Structured output: NDJSON, one JSON object per line. RESOLVED.
- Event shapes: NOT Codex-style step-start/tool/text/step-finish; they are
  session/agent_start/turn_*/message_*/tool_execution_*/agent_end. RESOLVED (mapping above)
- Working-directory: set via child-process `cwd` (no explicit `--dir` flag; Pi
  uses the process cwd). RESOLVED.
- Model targeting Ollama: `--provider ollama --model <id>` + `models.json`. RESOLVED.
- Approval bypass: N/A — Pi has no approvals; djimitflo is the sole gate. RESOLVED.
- AGENTS.md load order: global → parent dirs → cwd, concatenated. RESOLVED.

## Remaining for Phase 4 (end-to-end)

- Wire `PiExecutor` with the mapping above; confirm token metrics flow into
  djimitflo's `ExecutionMetrics`.
- Verify diff snapshot + risk classification populate for a Pi run on a real
  repo worktree.
- Decide containerization policy for `bash`-enabled tasks.
