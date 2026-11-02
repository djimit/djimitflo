# Runtime conformance matrix

- **Source:** `a4a083ac`. Paths are under `packages/server/src/` unless stated otherwise.
- **Prod state:** taken from the cited plan entries, with their dates. It was not re-queried.
- **Ledger:** the admission ledger is `execution/runtime-admission.ts:150-188`. Every record is `LEGACY_ADMITTED`, expiring `2026-12-31T00:00:00Z` (`:122`).
- **Enforcement:** the ledger has been enforced since 02-10, when RUNTIME_ADMISSION_MODE was removed (plan).
- **Version check:** the observed version comes from `runtime_contract_probes` taken since boot (`execution/execution-engine.ts:845-870`).

## 1. Status ladder

The four levels:
- **Registered:** it is in the engine's executor map.
- **Available:** its binary is in the image.
- **Operational:** it is used by prod loops, according to a dated source.
- **Conformant:** it meets every row of §2 with evidence.

| Runtime | Registered | Available | Operational | Conformant |
|---|---|---|---|---|
| opencode | yes (`execution/execution-engine.ts:168`) | yes, `Dockerfile:93` (1.18.10) | **yes**: incumbent maker and checker (plan Phase Y, 30-09; OBSERVED) | no: containment NOT_PROVEN (`runtime-admission.ts:152-154`) |
| remote (workstation, atomic) | yes (`:176`) | host-side: the pull worker `scripts/gym-worker.mjs` (`runMakerJob` `:460`) | **yes**: evolve sibling and gym (plan 01-10, 25-10; OBSERVED) | no: version unbound, no cancel channel |
| atomic, local (VPS executor) | yes (`:175`) | yes, `Dockerfile:80` (0.6.5 + sha256) | UNKNOWN. The atomic in prod runs on the workstation through the remote worker, not through this executor. | no: no structured interface |
| claude (subscription) | yes (`:170`) | binary yes (`Dockerfile:93`, 2.1.282). It needs an operator login in the container (`runtime-admission.ts:174`). | UNKNOWN: the login state in the container is unverified | no |
| codex | yes (`:169`) | binary yes (0.146.0) | **paused**: no sandbox in the container. The ledger says "not used by the loops in prod" (`:170`). | no |
| hermes, gemini, editor, pi | yes (`:171-174`) | **not installed** by the Dockerfile (`:93` installs codex, opencode and claude only) | no evidence of use | no. The plan (01-10) says to migrate or retire them before 2026-12-31. |
| mock | yes (`:167`) | in-process | test and demo only | n/a (a test double, W1 label) |

`deep-agent` is registered only when `DJIMIT_DEEP_ENABLED=true` (`:177-180`). It has its own sovereign hold and is out of scope here.

## 2. Contract rows

| Row | opencode | remote@workstation | atomic local | claude | codex | hermes / gemini / editor / pi | mock |
|---|---|---|---|---|---|---|---|
| **Admission profile and expiry** | LEGACY, bound to 1.18.10 | LEGACY, **unbound** (the host version is never observed) | LEGACY 0.6.5 | LEGACY 2.1.282 | LEGACY 0.146.0 | LEGACY, unbound | LEGACY, unbound |
| **Start / result / error** | `--format json` events, exit code, diff | job queued; `done` → `git apply` the patch, or `failed` / `cancelled` with a reason (`execution/executors/remote-maker-executor.ts:66-80`) | goal on stdin, plain text, diff | `--output-format json` | `exec --json` | exit code (not reviewed) | deterministic |
| **Cancel + confirmed termination** | process group: SIGTERM, then SIGKILL after 5 s; `close` and `processGroupExists` confirm it (`execution/executors/runtime-process.ts:95-115`; RUNTIME_PROCESS_GROUP_KILL=on, plan 25-10) | **DB flag only** (`services/remote-maker-queue.ts:80`). The worker is never told; a later result is refused as `late_result` (`:49-57`). Termination is unconfirmed. | as opencode | as opencode | as opencode | as opencode (all use `spawnRuntime`) | in-process |
| **Children** | same-group children are reaped. `setsid` escapes are not (`docs/research/orca/EVALUATION-REPORT.md:71`). Internal subagents: UNKNOWN. | named, labelled runner containers; `sweepOrphans` at start (`scripts/gym-worker.mjs:270-288,415-420`); atomic subagents UNKNOWN | as opencode | UNKNOWN | UNKNOWN | UNKNOWN | none |
| **Tool / fs / network / credential boundary** | none per tool (`services/tool-broker.ts:4-6`). Same uid as the control plane (S0, #948). Network unscoped. The env allowlist passes every provider key (`execution/executors/executor-env.ts:6-17`). | runner container on the host; only the patch enters, and it goes through the VPS gates | as opencode | subscription marker drops the billing keys (`executor-env.ts:30-31`) | `workspace-write` sandbox only on the subscription path; otherwise the bypass flag when skipPermissions is set (`execution/executors/codex-executor.ts:211-216`) | as opencode | n/a |
| **Usage reporting** (`token_accounting`, #818, `services/maker-token-accounting.ts:22-28`) | provider_reported | **unavailable** (`remote_maker_jobs` has no token column) | unavailable | provider_reported | provider_reported | runtime_log, else unavailable | unavailable |
| **Checkpoint / restart / reconcile** | no checkpoint. On boot: task → `unknown` + hold (`execution/execution-engine.ts:203-239`); run settled or `interrupted` (#880) | job row is durable, but after a VPS restart the lease is gone and the result is dropped as `late_result` (INFERRED from `remote-maker-queue.ts:55-77`) | as opencode | as opencode | as opencode | as opencode | `interrupted_in_process` |
| **Evidence coverage** | diff, checks, JSON events, tokens | patch, reason, host, species, base commit, plus queue log lines (`services/remote-maker-queue.ts:20-26`). No served-model or worker-version column (for the gym, see EPOCH1 prereg, "Known threats"). | diff only | JSON result | JSON events | UNKNOWN | n/a |
| **Known limits** | network egress and internal subagents unproven; `kimi-k2.6` fails through opencode (plan §7) | no cancel channel, no recovery, no usage | not used on the VPS | needs a login | paused | binary absent | no real change |

## Reading

- **Operational today:** two runtimes, opencode and remote@workstation.
- **Conformant:** none, because every runtime is `LEGACY_ADMITTED` and no runtime has evidence of containment.
- **Closest to conformant:** opencode. It lacks the tool boundary (S0) and child containment.
- **Remote** lacks cancel, recovery and usage. Those are exactly the missing [MILESTONE](MILESTONE.md) items.
- **Expiry:** after 2026-12-31 every record stops admitting unless it is migrated (expiry deny `runtime-admission.ts:101`; the migration list is at `:123-129`, and the stall detector warns 30 days before, `:112`). See [BACKLOG](BACKLOG.md) B13.
