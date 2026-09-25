# Design

## Reader And Action

Reader: the next Codex/OpenCode engineer or reviewer who needs to turn the current swarm foundation into a demonstrable workstation product slice.

Post-read action: implement and run one governed proof run that fixes known gaps and shows actual live Djimitflo output, not only plans or tests.

## Design Principle

The product must show a real chain:

`capability -> specialist panel -> claim -> backlog -> goal -> loop -> lease -> worker output -> trace -> checkpoint -> manifest -> memory candidate -> dashboard proof`

Any missing link is reported as missing evidence, not filled with optimistic text.

## Runtime Architecture

### Existing Execution Paths

Djimitflo currently has two related but not identical execution paths:

- Loop worker path: creates worker leases, worktrees, stdout/stderr artifacts, runtime usage, trace spans and checkpoints.
- Task execution engine path: registers Codex/OpenCode executors for direct task execution.

G16 must make both paths use one runtime contract source. A binary may be installed, but it is not eligible until the contract probe confirms the exact flags and output semantics Djimitflo will use.

### Required Runtime Contracts

Codex:

- command exists
- `codex --version` succeeds
- `codex exec --help` exposes `--json`
- `codex exec --help` exposes `--cd`
- JSON output is parsed or explicitly marked unknown
- timeout/kill behavior is recorded

OpenCode:

- command exists
- `opencode --version` succeeds
- `opencode run --help` exposes `--format`
- `opencode run --help` exposes `--dir`
- JSON events are parsed or explicitly downgraded with warning
- timeout/kill behavior is recorded

Mock:

- deterministic local runtime
- always emits parseable usage
- used before real Codex/OpenCode smokes

## Capability Architecture

Capabilities are split into:

- `runtime_adapter`: Codex CLI, OpenCode CLI, mock runtime, future OpenCode SDK adapter, future OpenAI Agents SDK adapter.
- `skill`: OKF/OpenCode/OpenAI skill contract.
- `mcp_server`: local or remote MCP capability.
- `connector`: OpenAI connector capability.
- `specialist_agent`: bounded specialist profile.
- `harness`: deterministic evaluator.

Only validated capabilities route worker execution. Candidate capabilities may appear in the dashboard and proof-run report, but they cannot start workers.

## Proof Run Data Model

Every proof-run-created record carries:

- `proof_run_id`
- `proof_run_kind`: `mock`, `codex_smoke`, `opencode_smoke`
- `created_by`: `swarm-proof-runner`
- `rollback_group`: same as proof run id
- `evidence_refs`
- `demo_record`: true

Rollback deletes by `rollback_group` and refuses to delete records without `demo_record: true`.

## Enforcement Model

The proof run uses product gates that keep the output real while allowing automation to proceed:

- path allowlist gate
- capability route gate
- governance gate
- capacity gate
- token budget gate
- wall-clock budget gate
- runner manifest gate
- memory promotion gate

Operational demo memory candidates can be marked proof-promoted when they are rollback-scoped. Policy/autonomy memory candidates remain candidate or review-required.

## Mission Control Output

Mission Control gets a proof section:

- latest proof-run id
- status: `not_run`, `running`, `passed`, `failed`, `rolled_back`
- current live counts
- expected minimum counts
- missing evidence list
- links to goal, loop, leases, traces, checkpoints, manifests, claims, panel and memory candidate
- rollback command/API reminder

The dashboard copy must distinguish:

- registry agents
- active runtime execution
- prepared leases
- completed proof records
- Ruflo bridge state

## OpenCode MCP And Skills Integration

OpenCode docs support global and per-agent MCP/tool exposure plus skill permissions. G16 should not turn every MCP or skill on globally. The proof run must:

- inspect project `opencode.jsonc`
- detect absent `mcp` and `permission.skill` sections
- run `opencode mcp list` with timeout
- classify `database is locked` as `locked`
- recommend per-agent MCP enabling for heavy or sensitive tools
- create capability candidates from configured MCP/skills
- avoid persisting OAuth tokens or headers

## OpenAI Agents, Skills And MCP Integration

OpenAI Agents SDK is modeled as an orchestration capability, not automatically used as the local worker runtime. G16 adds descriptors and adapter boundaries:

- OpenAI Agents SDK capability: external orchestration candidate.
- OpenAI Skills capability: hosted/local skill candidate with developer-reviewed contract.
- OpenAI MCP/connector capability: remote tool candidate requiring approval and authorization refs.

This lets Djimitflo plan and validate integrations without mixing external API orchestration into the local workstation worker path prematurely.

## Validation Strategy

1. Unit tests for fixed executor contracts.
2. Unit tests for G15 enforcement repairs.
3. Service tests for proof-run creation and rollback.
4. Authenticated API smoke for proof-run counts.
5. Dashboard smoke for proof section.
6. Mock proof-run before Codex/OpenCode.
7. Bounded Codex smoke.
8. Bounded OpenCode smoke or explicit blocked reason.

The proof is complete only when live output exists in the workstation DB and the dashboard/API expose it.
