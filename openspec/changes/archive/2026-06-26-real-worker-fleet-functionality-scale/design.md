# Design

## Real-Run Findings

The smoke run produced concrete engineering findings:

1. CLI adapter contract drift is real and must be detected before worker execution.
2. Token usage is the primary fleet-scale constraint.
3. Runtime artifacts are operational data and must not become source churn.
4. Maker execution without automatic checker execution is not yet a closed loop.
5. Runtime warnings are useful signals and should become structured telemetry.
6. Worker control artifacts should be separate from patch artifacts.
7. Scale must be visible as queue, capacity, throughput and bottleneck evidence.
8. The workstation is the execution node; dashboard/control surfaces may observe and trigger but must not pretend local UI state equals active workers.

## Architecture

### Runtime Contract Harness

Each runtime adapter exposes:

```ts
type RuntimeContract = {
  runtime: 'codex' | 'opencode';
  version: string;
  command: string;
  cwdFlag: '--cd' | '--dir';
  jsonFlag: '--json' | ['--format', 'json'];
  supportsJsonEvents: boolean;
  supportsUsageParsing: boolean;
  supportsTimeoutKill: boolean;
  lastProbedAt: string;
  status: 'ok' | 'drifted' | 'unavailable';
  evidence: string[];
};
```

The contract harness runs before leasing or executing real workers. A drifted contract blocks worker execution with an actionable error and dashboard state.

### Worker Context Budget

Small closed-loop worker runs get a dedicated low-context profile:

- minimal plugin/skill set,
- explicit system prompt from `.djimitflo/LOOP_WORK.md`,
- no broad unrelated workspace memory,
- bounded tool access,
- low-risk default token ceiling,
- runtime usage captured from JSONL and enforced at gate time.

The default budget should be conservative. High context is opt-in per goal, not implicit.

### Checker Worker Bridge

Maker and checker execution are separate endpoints:

- maker: may mutate files in its worktree.
- checker: read-only, receives assignment packet, maker diff, stdout/stderr, deterministic check output and gates.
- security checker: required for high-risk scopes.

Checker output is normalized into the existing checker verdict model.

### Control Artifact Isolation

Worktree control files move from:

```text
LOOP_WORK.md
ASSIGNMENT_PACKET.json
```

to:

```text
.djimitflo/LOOP_WORK.md
.djimitflo/ASSIGNMENT_PACKET.json
.djimitflo/runtime/
```

The control directory is ignored in the worker worktree so `git status` and diff gates reflect patch output only.

### Runtime Warning Gate

Runtime warning parser extracts:

- plugin hook parse errors,
- skill budget warnings,
- MCP/session cleanup warnings,
- unavailable tools,
- JSONL parse failures,
- usage missing when expected.

Warnings are stored as `runtime_warnings` on the lease metadata. They can be advisory, warning, or blocking depending on loop risk class.

### Auto-Verify Closure

After maker completion:

1. Run deterministic checks.
2. Execute checker worker.
3. Execute security checker when required.
4. Update gates.
5. Move to `ready_for_human_merge` when all non-human gates pass.
6. Complete only after explicit human approval or non-mutating loop closure.

### Fleet Pool And Queue Model

Djimitflo should treat worker capacity as a visible operating surface:

```ts
type FleetPoolStatus = {
  runtime: 'codex' | 'opencode' | 'mock' | 'manual';
  available: boolean;
  prepared_leases: number;
  queued_leases: number;
  running_leases: number;
  completed_24h: number;
  failed_24h: number;
  average_runtime_ms: number | null;
  tokens_used_24h: number;
  tokens_per_successful_worker: number | null;
  recommended_concurrency: number;
  blocked_capacity_reasons: string[];
};
```

Prepared work is not active execution. Running workers require runtime evidence. Queue depth and blocked reasons must be visible before any operator scales workers.

### Fleet Cockpit

The dashboard should show:

- goal -> loop -> lease -> runtime -> artifact -> gate topology,
- prepared/running/completed/failed lease counts,
- worker pool capacity by runtime,
- queue depth by risk class and runtime,
- token burn and tokens per useful diff,
- warnings and blocked gates,
- next safe actions such as run maker, run checker, split, retry, stop or require human review.

The cockpit is not marketing UI. It is an operations surface for repeated use.

### Backlog To Fleet Flow

The scale flow is:

1. Discovery projects valuable work to backlog.
2. Triage sets value, confidence, risk and recommended loop.
3. Batch planning converts selected items to goals.
4. Goal decomposition creates loop candidates.
5. Operator approval prepares leases.
6. Capacity scheduler starts bounded workers.
7. Checker/security/check gates close the loop.
8. Backlog status updates with preserved artifacts and failure evidence.

## `/goals` Batch Model

`goals.batch.json` is the operator-facing batch artifact. It contains ordered goals with dependencies and API-ready payloads for `POST /api/goals`. The batch registers intent only; execution still flows through decompose/start/continue/execute-worker/checker gates and resource-aware capacity controls.

## Rollback

- Disable the new runtime contract enforcement flag and fall back to current adapter dispatch.
- Keep `.data/agent-evidence` artifacts for audit.
- Existing worker leases remain readable.
- No schema migration may delete historical stdout/stderr/checkpoint/trace evidence.
