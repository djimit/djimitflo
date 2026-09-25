# Phase 0 Evidence — add-pi-executor

**Date:** 2026-06-20
**Where:** Ubuntu workstation (`ssh workstation`), the execution node.
**Pi version:** 0.79.8 (`@earendil-works/pi-coding-agent`), installed via
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (Node v22.23.0).
**Full contract + samples:** [`docs/pi.md`](../../docs/pi.md)

## What was captured live

- `pi --help` (full flag set) — archived in docs/pi.md.
- `pi --list-models` confirms the custom Ollama provider lists
  `llama3.1:8b`, `qwen2.5-coder:7b`, `qwen3-coder:30b-a3b-q4_K_M`.
- A zero-egress sovereign run: `pi --mode json -p --offline --no-session
  --no-approve --no-context-files --no-extensions --no-skills --provider ollama
  --model llama3.1:8b --tools read,ls "..."` produced a real NDJSON event
  stream served entirely from `localhost:11434`.

## Key corrections to the original skeleton (this is why Phase 0 was a hard gate)

1. **Event schema is NOT Codex-style.** Pi emits
   `session` / `agent_start` / `turn_start` / `message_*` /
   `tool_execution_start|end` / `turn_end` / `agent_end`, not
   `step-start`/`tool`/`text`/`step-finish`. The `PiExecutor` mapper must be
   Pi-specific. Verified mapping table is in docs/pi.md and design.md should be
   read alongside it.

2. **No permissions / no `PI_SKIP_PERMISSIONS`.** Pi has no permission popups;
   it runs with the user's perms. djimitflo's policy engine is the **sole**
   boundary. Risk control = `--tools` allowlisting (drop `bash` for low-risk) +
   containerization for `bash`/sensitive repos. File tools are cwd-scoped by
   default (good for worktree isolation); `bash` is the escape hatch = high-risk.

3. **Working directory has no `--dir` flag.** Pi uses the child-process `cwd`.
   djimitflo sets it via `spawn(..., { cwd: worktree })`.

4. **Egress hygiene is mandatory for "zero egress".** Pi phones home to pi.dev
   at startup unless `--offline`/`PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1` +
   `PI_TELEMETRY=0` are set. Without these the Success Criterion is not met.

5. **AGENTS.md precedence.** Pi loads `~/.pi/agent/AGENTS.md` -> parent dirs
   (walking up) -> cwd, concatenated. `-na`/`--no-approve` skips project
   settings/extensions/skills but **still loads context files** — use `-na` for
   deterministic executor runs.

## Open Questions — status

All seven Open Questions in proposal.md are RESOLVED (see docs/pi.md
"Open questions resolved by this capture"). The original proposal/tasks/design
files still carry the pre-capture wording because the sandbox blocks
overwriting existing files in this session; docs/pi.md is the authoritative
record and supersedes any Codex-style mapping assumption in design.md. The
implementation phases (1–5) should follow docs/pi.md, not the original
Codex-shaped mapping text.

## Phase 0 task status

- [x] T00.1 Pi binary located & installed on workstation (`~/.npm-global/bin/pi`)
- [x] T00.2 `pi --help` captured → docs/pi.md
- [x] T00.3 Headless invocation identified: `--mode json -p` (and `--mode rpc`)
- [x] T00.4 Structured output = NDJSON; ≥3 event samples captured → docs/pi.md
- [x] T00.5 Working-dir = process cwd; model flag = `--provider`/`--model` to Ollama
- [x] T00.6 Approval behavior: none (no popups); djimitflo is sole gate
- [x] T00.7 AGENTS.md load order confirmed (global -> parents -> cwd)
- [x] T00.8 Version recorded: 0.79.8

Phase 0 validation criteria met: docs/pi.md exists with help + invocation +
samples; a zero-egress local-Ollama run produced captured output; working-dir
and model flags confirmed.

## Reproduce

```bash
ssh workstation
export PATH=~/.npm-global/bin:$PATH PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1
cd /tmp && rm -rf pi-smoke && mkdir pi-smoke && cd pi-smoke && echo "hello world" > greet.txt
pi --mode json -p --offline --no-session --no-approve --no-context-files \
   --no-extensions --no-skills --provider ollama --model llama3.1:8b \
   --tools read,ls "Use the ls tool to list files, then read greet.txt."
```

## Next (Phase 1+)

Implement `pi-executor.ts` per the verified mapping in docs/pi.md. The hard gate
is cleared.
