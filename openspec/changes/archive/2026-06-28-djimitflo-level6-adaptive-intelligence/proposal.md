# DjimFlo Level-6 — Adaptive Intelligence & Self-Evolving Swarm

## Why (the real gap, not a feature list)

DjimFlo at Level-5 + wiring (`57cd6116`) is a **parallel, negotiating, decomposing,
steerable, growing, resource-aware, injection-safe, federated** agentic OS. All G1-G27
capabilities are implemented AND wired into the execution path. 78/78 tests green.
Production proof green on the workstation.

**It is not yet intelligent.** The gaps are cognitive, not operational:

### A. The self-improvement loop is closed but passive

1. **No competence-per-runtime tracking.** `measureCompetence` tracks `success_rate` per
   capability, but not per `(capability, runtime)`. If codex fails 3x on TypeScript
   findings but opencode succeeds, the system doesn't learn this — `selectRuntime`
   doesn't see runtime-specific competence. **Result**: the planner assigns the same
   runtime every time, even when history shows it fails.

2. **No adaptive planner.** `planLoopRun` selects by `success_rate / p50_cost` (the
   market), but it doesn't use distilled rules. If a distilled rule says "codex fails on
   TypeScript null-guard errors, use opencode instead," the planner ignores it — it
   reads competence from the DB, not from the procedural memory store. **Result**: the
   planner makes the same mistakes repeatedly.

3. **No meta-evolution.** The system learns from individual runs (distillFromRun,
   measureCompetence) but doesn't evaluate itself over time. It can't answer: "are my
   distilled rules accurate?", "should I merge or split capabilities?", "are there dead
   capabilities that are never used?" **Result**: the system accumulates knowledge but
   doesn't curate it — bad rules persist, good rules aren't reinforced.

### B. Skills are inert and specialists are generic

4. **Skills are empty.** The OKF `skills/` directory has 4 `.md` files
   (execution-loop, governance-loop, goal-intake-loop, memory-loop) but `SkillService`
   doesn't inject them into maker assignments. The maker gets vector-memory (Qdrant
   retrieval) but not **explicit procedures** ("step 1: read the finding, step 2:
   analyse the code, step 3: write the fix, step 4: verify"). **Result**: specialists
   operate with experience but not with procedure — they improvise every time.

5. **No specialised capabilities.** The DB has capabilities with `allowed_actions:
   ['spawn_runtime_worker']` but they're all the same generic skill. There's no
   "TypeScript-fix" capability with high competence on TS findings and low on Python.
   **Result**: the swarm is a team of generalists, not specialists — every maker is the
   same maker.

6. **The memory_curator is a placeholder.** The memory_curator nested specialist adds a
   comment in the proof, but doesn't actually curate memory: it doesn't distill rules,
   update trust scores, detect contradictions, or write to the right store. The
   `distillFromRun` call happens in the proof-run-service, not in the curator. **Result**:
   the curator role is a label, not a function.

### C. The evolution loop is missing

7. **No self-evaluation.** The system doesn't assess its own performance over time. It
   can't say "my planner accuracy improved from 60% to 80% over the last 10 runs" or
   "rule X has been contradicted 3 times — demote it." **Result**: the system grows
   blindly — it accumulates but doesn't curate.

8. **No capability lifecycle.** Capabilities are created (G23 autonomous acquisition) and
   promoted/deprecated (G1 autoPromote/autoDeprecate), but there's no periodic cleanup:
   unused capabilities, duplicate capabilities, or capabilities that should be merged.
   **Result**: the capability set grows but never shrinks or reorganizes.

## The Level-6 thesis

DjimFlo becomes an **adaptive, self-evolving** agentic OS when four things are true:

- **Runtime-adaptive by evidence**: the planner tracks competence per `(capability,
  runtime)` and selects the runtime that historically works best. If codex fails on TS
  but opencode succeeds, the planner routes TS findings to opencode. The fleet adapts
  from evidence, not from static rules.

- **Procedural, not just experiential**: the maker gets explicit skill procedures
  injected alongside vector-memory. A skill is a typed procedure ("step 1...step N")
  that the maker follows, not just a knowledge blob it reads. The swarm operates with
  procedure + experience, not experience alone.

- **Self-curating memory**: the memory_curator is the active curator — it distills
  rules, updates trust scores, detects contradictions, and writes to the right store.
  The system curates its own knowledge: bad rules are demoted, good rules are
  reinforced, contradictions are resolved.

- **Self-evaluating**: a meta-evolution loop periodically evaluates the system's own
  performance: planner accuracy, rule accuracy, capability usage. Dead capabilities
  are pruned. Inaccurate rules are demoted. The planner's assignment model is updated
  from observed outcomes. The system evolves its own structure, not just its parameters.

## What Changes (each is a Goal in `tasks.md`)

- **G28 Competence-per-runtime tracking**: `measureCompetence` tracks success_rate per
  `(capability, runtime)`. `selectRuntime` uses this to pick the best runtime.
- **G29 Skill injection**: `SkillService` injects relevant skill procedures into maker
  assignments alongside vector-memory. The maker gets procedure + experience.
- **G30 Active memory curator**: the memory_curator nested specialist does real
  distillation, trust updates, and contradiction detection — not the proof-run-service.
- **G31 Specialised capabilities**: TypeScript, Python, Security, Docs capabilities in
  the DB with their own competence measurements. The swarm becomes a team of specialists.
- **G32 Meta-evolution loop**: a periodic self-evaluation: planner accuracy, rule
  accuracy, capability usage. Dead capabilities pruned, inaccurate rules demoted.
- **G33 Adaptive planner**: the planner uses distilled rules + competence-per-runtime
  to make better assignments. It learns from mistakes — the same error doesn't recur.
- **G34 Ship**: a real production goal where the swarm is measurably SMARTER after 5
  runs than after 1 run (higher success rate, lower cost, fewer retries). OpenSpec closure.

## Non-Goals

- No new runtime (codex/opencode/pi remain).
- No new DB (existing tables extended).
- No "consciousness" or "self-awareness" claims.
- No re-architecture of Level-3/4/5 verified baseline.
