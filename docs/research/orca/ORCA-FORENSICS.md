# Orca source forensics

## Scope and pinning

| Field | Value |
|---|---|
| Repository | https://github.com/stablyai/orca |
| Pinned commit | `976fa11e81ff5898e515f5b101070df8e1d6b077` (2026-10-24 14:13 -0700, "fix(github): send a paired server its own repo id when an SSH row shares the path (#33257)") |
| Licence | MIT, "Copyright (c) 2026 Lovecast Inc." (`LICENSE`). Patterns may be adapted with attribution. No code is copied into DjimitFlo by this work, and no dependency is added. |
| Method | `git clone --depth 1` into the session scratchpad. Source was read only: nothing was installed, built or run. The clone was deleted afterwards. |
| Size | 39 203 files. About 16 400 non-test `.ts` files under `src/`. It is an Electron desktop app (main, renderer, preload) plus `orcad` (headless daemon), the `orca` CLI, a mobile companion and a cloud folder. |
| Reading depth | The repo is too large to read in full. Excerpts of each mechanism below were read: three parallel read-only passes plus my own reading of `src/packages/process-host`. Paths are relative to the repo root. |

**What Orca is.** A desktop "AI orchestrator". It runs Codex, Claude Code, OpenCode, Pi and about 45 other CLIs side by side, each in its own git worktree, inside interactive PTYs. A human watches and steers them. DjimitFlo is a headless control plane: one-shot CLI runs per lease, gates, and evidence. Most of Orca's code serves the interactive IDE case (PTY attach, scrollback, terminal-title heuristics, mobile pairing), and none of that transfers.

Tags used: **F** = read in source, **I** = inferred from source.

## 1. Worktree orchestration

**Create** (F)
- `src/main/git/worktree-add.ts` `addWorktree()` → `performAddWorktree()` runs `git worktree add --no-track -b <branch> <path> <base>`.
- The timeout is re-read on every call (`resolveWorktreeAddTimeoutMs`).
- The base ref is persisted as `branch.<b>.base` with `git config --local`. If that write fails, the key is unset, so stale lineage never survives.

**Concurrency** (F)
- In-process: a per-repo-realpath promise lane, `src/shared/git-operation-lock.ts` `runWithGitOperationLock`.
- In-flight registry: `worktree-create-in-flight.ts` hides half-created rows.
- `assertNoPendingWorktreeRemovalConflict` stops a create from reusing a path or branch that a background removal still owns.

**Cross-process ownership** (F)
- Orca reuses Git's own `worktrees/<id>/locked` file, written with `{flag:'wx'}`.
- The lock reason encodes `orca-create-preparation:v1:<pid>:<session>:machine=<id>`, and unlock verifies that reason first (`worktree-preparation-lock.ts`).

**Orphans** (F)
- `worktree-create-preparation-stale-cleanup.ts` trusts `kill(pid,0)` → ESRCH only when the recorded machine is this machine.
- `canSafelyRemoveOrphanedWorktreeDirectory()` (`worktree-removal-safety.ts`) deletes a directory only with positive proof: a `.git` *file* that points back at this repo's admin dir (`worktree-orphan-gitdir-proof.ts`).
- The rule appears in comments throughout: "path shape alone must never hide or force-remove it".

**Persistence** (F)
- Removal records live in `orca-worktree-removals.json`.
- Names come from a marine-creature list. Retired names are never reissued, because agent CLIs key their history by cwd.

**Deps.** git and `proper-lockfile`.
**Maintenance cost.** High: about 60 files for worktree lifecycle, including WSL and Windows special cases.

## 2. PTY and session lifecycle

**Daemon survives app restart** (F)
- `src/main/daemon/daemon-launched-child-spawn.ts` forks with `detached: true`.
- Endpoint ownership is claimed with an identity-checked link/rename protocol (`daemon-endpoint-ownership.ts`). Its rule: "Never collapse 'can't tell' into 'dead'".
- Sessions move through `created|spawning|running|exiting|exited` (`daemon/types.ts`, `session.ts`).

**Process-tree termination** (`src/packages/process-host`, zero runtime deps, bundled to remote hosts) (F)
- `process-tree-termination.ts` `signalProcessTree()`: "POSIX children must be detached: signaling -pid targets the process group". It calls `process.kill(-child.pid, signal)`.
- `forceTerminateProcessTree()` sends SIGKILL to the group, then polls `ps -axo pgid=,state=` until every member is gone or a zombie (`waitForPosixProcessGroupQuiescence`, 2 s budget).
- `process-tree-kill-gate.ts`: an injectable gate can refuse the group kill. The caller then kills only the root through its handle.
- `run-process.ts`: `terminationBarrier` specs force `detached: true` on POSIX (`spawn-resolution.ts:26`). `PROCESS_EXIT_GRACE_MS = 2_000` is how long children that ignore termination get. Windows uses `taskkill /T`.
- `daemon/session-termination-controller.ts`: agent launches use `killWithDescendantSweep`, with the comment "Detached agent tool groups can survive the shell's SIGHUP". An `ownsRoot` guard protects against PID recycling.

**Idle verdict** (F) — `agent-turn-idle-verdict.ts` `judgeIdleAgentTurn()`:
1. `completed` if a fresh hook `done` row arrived after `sentAt`.
2. Otherwise `failed` if one of the last 6 lines is a shell "command not found" naming the agent.
3. Otherwise `completed` only when no status rows exist and 2 min have passed; else `wait`.

**Scrollback** (F)
- Stored as a length-prefixed frame log with a generation header, plus a headless-xterm checkpoint written tmp → rename (`terminal-history-log.ts`).

**Deps.** `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`.
**Maintenance cost.** Very high. It is the core of the IDE.

## 3. SSH remote exec and reconnect

**Transport** (F)
- `ssh2` with `readyTimeout 30s` and `keepaliveInterval 15s`, plus a system-ssh fallback.
- An `orcad` server runs on the remote host, reached over an SSH exec stdio bridge (`src/main/ssh/orcad-stdio-bridge.ts`). Frames are multiplexed JSON-RPC.

**Reconnect** (F) — `connection/ssh-reconnect-ladder.ts`:
- Backoff `[1,2,5,5,10,10,10,30,30]` s.
- Gives up after 9 failed handshakes; flaps alone never cause a give-up.
- 60 s of uptime resets the delay.
- Each attempt claims a generation, and superseded attempts publish nothing.
- Auth errors are never retried.

**Liveness** (F)
- `src/shared/remote-runtime-socket-liveness.ts` pings every 10 s and declares death after 25 s of silence.
- A timer tick more than 1.5× late (sleep or throttling) triggers a re-probe instead of a death verdict.

**Sessions on disconnect** (F)
- Remote PTYs keep running.
- A client lease that is `expired` "says only that the CLIENT lost its route, never that the remote shell died".
- Kills that could not be confirmed persist as `pendingKill`, fenced by an incarnation id (`src/shared/ssh-pending-pty-kill.ts`).

**Trust** (F)
- Host keys: `known_hosts` is read and never written. Accepted keys are scoped to host+port+keyType.
- Runtime channel: a NaCl E2EE handshake against a pinned host key.

**Deps.** `ssh2`, `tweetnacl`, `ws`.

## 4. Agent CLI adapters and provider abstraction

**Terminal agents** (F)
- About 45 entries in `src/shared/tui-agent-config.ts`, each with `detectCmd`, `launchCmd`, `expectedProcess` and `promptInjectionMode` (`argv | flag-prompt | stdin-after-start`), plus per-agent paste-ready signals.

**Structured agents** (F)
- Claude: `@anthropic-ai/claude-agent-sdk` `query()`, with a scrubbed env.
- Codex: `codex app-server` JSON-RPC.
- ACP agents: listed in `acp/acp-launch-specs.ts`, each with `minimumVersions`.
- Pi: `--mode rpc`.

**Version probe** (F) — `agent-cli-version-probe.ts`:
- Runs `--version` with a 5 s timeout and 4 KiB output cap, killing on the limit.
- Fails open (an `unknown` version still launches).
- Per-major minimum floors.

**Workspace trust pre-writes** (F)
- `agent-trust-presets.ts` writes Cursor, Copilot, Antigravity and Codex trust before launch, under deadlines of 20 s for Codex and 1.5 s otherwise.

**Turn state** (F)
- Hook-first: managed hooks POST to a loopback server with a per-start token, with a file-spool fallback.
- The event → phase mapping is in `shared/agent-hook-listener/providers/claude-events.ts`.

## 5. Concurrent agents and admission

There is no global agent cap (F).

**Host terminal cap** (F)
- `daemon/host-terminal-ledger.ts`: `DEFAULT_MAX_HOST_TERMINALS = 256`, shared across daemons through a uid-owned ledger dir.
- `tryReserve` publishes its own reservation first, then rolls back if the total is over the cap.

**Spawn admission** (F) — `src/shared/host-spawn-admission.ts` `decideSpawnAdmission`:
- A pure, clock-injected function returning `admit|wait|defer|refuse_retryable`.
- Defaults: 3 concurrent, 1 token/s, burst 3, max 8 live automatic.
- Interactive spawns are always admitted, and a client cannot claim "interactive".

## 6. Diff collection and review

**Status** (F)
- `git status --porcelain=v2 --untracked-files=all`, capped at 1 000 entries (`didHitLimit`).
- `GIT_OPTIONAL_LOCKS=0` on read-only polls, so they don't fight the agent for `index.lock`.

**Stats and diffs** (F)
- Stats: `diff -z --numstat -M`, run staged, unstaged and untracked in parallel. A failed pass is `null`, never 0.
- Per-file diffs: both blobs are read (`git show`, 10 MiB cap) and diffed in the UI.
- Settled-diff cache: keyed on HEAD, index and mtimes, and refuses mtimes within 2 s of capture.

**Review comments** (F)
- `DiffComment {filePath, lineNumber, body, scope, sentAt}`, formatted deterministically for the agent.

**PR creation** (F)
- `src/main/github/client/create/create-github-pull-request.ts` runs `gh pr create --body-file … --draft`.
- An ambiguous result or "already exists" is followed by a lookup (`findOpenPRByHeadBase`) instead of a retry.
- `gh` calls go through a 4-slot FIFO semaphore.

## 7. Task → agent assignment and the automation engine

**Work items** (F)
- Issues from GitHub, GitLab, Linear or Jira are linked to a worktree (`src/shared/new-workspace/workspace-source.ts`), and the prompt comes from a template.

**Scheduler** (F) — `src/main/automations/service.ts`:
- 60 s polling with a non-overlap guard.
- `rrule` schedules.
- Missed-run policy `run_once_within_grace`.
- Run states `pending → dispatching → dispatched → completed | skipped_* | dispatch_failed`.

**Dispatch** (F)
- `automation-dispatch-request.ts` claims durably, then re-checks a deep-equal snapshot of the definition and destination before launching.
- One-time dispatch tokens with a 30 min TTL.
- There is no exponential retry.

## 8. Browser and computer use

**Browser** (F)
- An embedded Electron webContents driven over CDP (`src/main/browser/cdp-bridge.ts`), plus the bundled `agent-browser` binary.
- Loopback guard: reject any `Origin` header and require an exact `127.0.0.1:<port>` / `localhost:<port>` Host (`cdp-loopback-request-guard.ts`).

**Computer use** (F)
- macOS: a native Swift helper over a Unix socket.
- Linux and Windows: script providers.
- Every action is validated per method.

## 9. Persistent session state

**Profile state** (F)
- SQLite (`node:sqlite`) with WAL, `synchronous=FULL`, `BEGIN IMMEDIATE` and an expected-revision fence.
- `ProfileStateIndeterminateWriteError` is raised on an ambiguous COMMIT.
- 5 rotating backups (`src/main/persistence/profile-state/`).

**Durable file write** (F) — `src/main/durable-file-write.ts`:
- Write the temp file, fsync it, rename (with an `isCurrent()` veto), then fsync the directory.
- `publishFileDurableSync` is a no-overwrite publish via `link`.
- Weak spot: `atomic-snapshot-writer.ts` and `active-view.json` skip fsync.

**File transaction lock** (F)
- `proper-lockfile`, 20 randomized retries (`file-transaction-lock.ts`).

## 10. CLI automation

**Commands** (F)
- About 294 `CommandSpec`s in `src/cli/specs`.

**Transport** (F)
- NDJSON over a Unix socket or named pipe, one request per connection, with a timeout per request.
- Auth token: `randomBytes(24)` per run, stored in an owner-only `orca-runtime.json`.
- Weak spot: it is compared with `===`, not timing-safe (`runtime-rpc-request-admission.ts:140`).

## 11. Usage tracking

**Claude** (F)
- Parses `~/.claude/projects/**/*.jsonl` assistant records.
- Dedupe key `${messageId}:${requestId}`, then `msg:`, then `uuid:`; duplicates are merged with `Math.max` per column.
- Each key has one owner file, which handles forks.
- Incremental reads resume only when the sha256 of the head window and the boundary window still match.

**Codex** (F)
- Reads rollout `token_count` events and prefers `last_token_usage` as the increment.
- The dedupe key leaves out the session id.

**Rate limits** (F)
- HTTP: Claude OAuth usage endpoint, Codex app-server `account/rateLimits/read`.
- Polled every 15 min with backoff.

**Pricing** (F)
- A static per-model pricing table.

## 12. UI and observability

**Status protocol** (F)
- OSC 7501 in-band program status, with strict regexes and a 4096-byte cap.

**Tracing** (F)
- AsyncLocalStorage spans.
- A synchronous NDJSON sink with rotation (10 MB × 10, 0600).
- Redaction at three points: sink, bundle and ingest.

**Crash reporting** (F)
- Crashpad with `uploadToServer:false`.
- Diagnostic bundles are uploaded only after the user reviews them.

## Suitability summary

| # | Mechanism | Licence | Suitability for a headless control plane | Maintenance cost if adopted wholesale |
|---|---|---|---|---|
| 1 | Worktree orchestration | MIT | Patterns: positive-proof orphan deletion, lock-reason ownership | High |
| 2 | PTY/session lifecycle | MIT | PTY: none (DjimitFlo is headless). **Process-group termination: high** | PTY very high; process-group termination low |
| 3 | SSH exec + reconnect | MIT | Low: DjimitFlo deliberately uses a pull model | High |
| 4 | Agent adapters | MIT | Medium: version floors fail-open; trust pre-writes are not needed for one-shot runs | High (about 45 agents) |
| 5 | Concurrency/admission | MIT | Low to medium: DjimitFlo already has a semaphore plus daily caps | Low |
| 6 | Diff/review/PR | MIT | Medium: "look up instead of retrying a non-idempotent create" | Low |
| 7 | Task assignment / automations | MIT | Low: DjimitFlo's goal → run → lease pipeline is richer | — |
| 8 | Browser/computer use | MIT | Low: no verified need; large trust surface | High |
| 9 | Persistent state | MIT | Already SQLite in DjimitFlo; the durable-file-write pattern has niche value | Low |
| 10 | CLI automation | MIT | Low: DjimitFlo has REST, MCP and scripts | — |
| 11 | Usage tracking | MIT | Medium later: transcript dedupe for claude/codex makers (idle in prod today) | Medium |
| 12 | Observability | MIT | Low to medium: the 3-point redaction pattern | — |
