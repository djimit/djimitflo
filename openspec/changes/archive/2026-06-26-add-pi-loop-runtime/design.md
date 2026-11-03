## Architecture

### Positioning

Pi becomes a **one-shot, per-lease loop runtime**, joining codex/opencode/claude/
gemini/editor/mock in `LoopService`'s execution plane. The control plane
(`LoopService`: goals, loops, leases, budgets, gates, maker/checker, spawn tokens,
nested-spawn lineage) is unchanged; only the runtime set gains `'pi'` and a
command/contract case.

This is the *consistent* realization of "Pi = execution plane" — it reuses the fleet
infrastructure the other runtimes already use, rather than adding a parallel path.

### Why one-shot, not a persistent worker / RPC

Measured 2026-06-21 (workstation, `ollama/llama3.1:8b`):

- `pi --version` (Node+Pi bootstrap): ~615 ms.
- Startup fraction of a small coding task: ~33 % (615 / 1864 ms).
- Concurrency: 4 parallel tasks → 3.52× speedup (1127 ms wall vs 3965 ms serial).

Startup is a per-lease cost that **overlaps** under concurrency; it is not a shared,
contended resource and does not set the throughput ceiling (which is the worker-
concurrency budget and, at scale, ollama GPU). A persistent Pi-SDK worker would add
a component to operate (lifecycle, transport, crash-recovery) without lifting the
ceiling. RPC's only real upside (`steer`/`abort`/`get_state`) is unused: `abort` is
already SIGTERM, and mid-run steering has no demonstrated need. So: one-shot
`pi --mode json -p`, matching codex/opencode.

If startup ever bites (serial, very short, high-frequency tasks), the cheaper lever
is Pi's compiled binary (`build:binary` → `bun --compile`, no Node startup), not a
worker pool.

### Runtime Command (Pi)

`buildRuntimeCommand('pi', worktreePath, prompt, skipPermissions)` →

```
pi --mode json -p --no-session --no-approve --no-context-files \
   --no-extensions --no-skills --offline \
   --tools <PI_TOOLS> --provider <PI_PROVIDER> --model <PI_MODEL> \
   <prompt>
```

- `cwd = worktreePath` → Pi's cwd-scoped file tools (read/ls/edit/write) are confined
  to the lease worktree. **No `metadata.workingDirectory` plumbing needed** (unlike
  the manual `executeTask` path, the loop controls cwd directly).
- `skipPermissions`: Pi has no permission popups, so this is effectively always-true
  at the runtime layer. Risk control stays where it belongs: djimitflo approval
  **before** the lease + `PI_TOOLS` allowlisting (drop `bash` for low-risk).
- Egress hygiene via env: `PI_OFFLINE=1` + `PI_TELEMETRY=0` + `PI_SKIP_VERSION_CHECK=1`
  (mandatory for sovereign/zero-egress runs).

### Shared Helper (no duplication)

`buildPiArgs` + `mapPiEvent` are extracted from `pi-executor.ts` into a shared
module used by **both** the manual `PiExecutor` and the loop runtime adapter. One
source of truth for Pi flags and NDJSON→event mapping; the two paths cannot drift.

### Token Usage + Events

- `usage_source: 'runtime_stdout'` — parse Pi `message.usage` (input/output/totalTokens)
  into the worker-lease runtime metrics, identical to codex/opencode.
- Pi NDJSON events routed through the loop's event/trace handling via the shared
  `mapPiEvent`; maker/checker, diff snapshot, risk classification, and trace spans
  populate the same way as the other runtimes.

## Risks

- **Two Pi paths diverging**: the manual `PiExecutor` and the loop runtime could
  drift in flags/mapping. Mitigation: shared helper (Phase 1) — both import it.
- **Pi binary absent on a host**: loop requests `runtime:'pi'` and fails late.
  Mitigation: `getRuntimeContract('pi')` probe + `assertRuntimeAvailable` fails fast
  with `RUNTIME_UNAVAILABLE` before a lease is created.
- **Sovereign-egress regression**: forgetting the three `PI_*` offline vars leaks to
  pi.dev. Mitigation: document + the contract probe can warn when `PI_OFFLINE!=1`.
- **`bash` in `PI_TOOLS`**: escape hatch with user perms. Mitigation: default
  `PI_TOOLS` excludes `bash`; high-risk runs require djimitflo approval + (recommended)
  containerization — unchanged from the manual path.

## Mitigations

- Shared helper = single implementation.
- Early availability probe = fail fast.
- Default toolset without `bash`; risk via djimitflo gate, not Pi.
- Offline env documented and probed.

## Rollback

Revert the `'pi'` union additions (4 sites + `RuntimeContract`), the
`buildRuntimeCommand`/`getRuntimeContract` `'pi'` cases, and re-inline the shared
helper back into `pi-executor.ts` if desired. The manual `PiExecutor` path is
independent and keeps working. No other runtime is affected.
