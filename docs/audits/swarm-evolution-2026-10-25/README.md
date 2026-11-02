# Swarm value, learning and resource efficiency audit

Inspected live: `/agents`, `/swarm`, `/swarm-mission-control`, 25 October 2026 Europe/Amsterdam (retained runtime captures 24 October 23:39–23:49 UTC). Deployed source/build: `e8d0de33bbae8736d7ab0b4f9195292a2e9f56aa`, independently checked out for source analysis and isolated tests. Production remained read-only.

**Conclusion:** DjimitFlo has real execution feedback, memory reuse, runtime selection, guarded closures, GPU metering and registered experiments. It does not yet establish that every swarm becomes more capable or efficient. The three requested pages mix registry state, historical counters, bounded projections and evidence-completeness scores. Improve those connections and finish existing experiments before adding residents, training loops or another optimizer.

Detailed [learning and efficiency design](learning-and-efficiency-design.md), [implementation backlog](backlog.md) and [evidence/functional coverage](evidence.md) accompany this assessment. OBSERVED denotes live UI/data; VERIFIED denotes implementation, recomputed evidence or isolated reproduction; INFERRED denotes an explanation/design; UNVERIFIED denotes effectiveness or attribution not demonstrated.

## The three pages

| Page | Observed behavior | Operational assessment |
|---|---|---|
| Agents | Cards show registered worker identities, connection states and lifetime counters. Zero-task workers show 0% success. Lower down, 30-day runtime scorecards show sample sizes, Wilson intervals, latency, failure classes and unknown prices | The scorecards are useful existing infrastructure. Cards need the same cohort/provenance discipline. Registry labels, heartbeat, successful reply and successful execution are distinct. No per-swarm learning/resource history is exposed here |
| Swarm | 32 “Active Agents”; cumulative tokens 0 and execution time 0. Recent worker tasks nevertheless show measured tokens and duration. Learning feed contains two July entries. Fleet pools and capability cards appear farther down | Misleading aggregation, not absence of execution. This route reads stale agent counters for totals and a separate manual learning table for the feed. It should reuse current execution/closure/usage evidence |
| Mission Control | 32 registry entries, one live agent, 17 prepared leases, zero running/active execution at the observed instant. Historical proof is completed but explicitly incomplete for real runtime certification. Capability/claim health use bounded lists. “Learning Curve (100 runs)” displays 100%→100% and $0→$0 | Correctly distinguishes registry and execution at the top. Learning/economics labels below it are weaker: first/last binary statuses are called rates; costs use fallback runtime tariffs and missing usage can appear free. A successful proof-record operation is not a certified production swarm |

Screenshots: [Agents](01-agents.png), [existing scorecards/native-agent row](01-agents-native.png), [Swarm](02-swarm.png), [Mission Control](03-mission-control-top.png), [displayed learning curve](03-learning-curve.png). Some Safari accessibility reads omitted visibly rendered Agents content; visual evidence, not an inferred blank-page defect, supports that page. The user later changed browser tabs; deeper read-only UI interactions were stopped and the out-of-scope capture discarded.

## What the current evidence actually supports

**VERIFIED — zero displayed tokens does not mean zero resource use.** All 32 `agents` rows have status active, with aggregate token/time counters zero. The existing seven-day resource reader reports 27,131,480 recorded cloud tokens and 1,895,721 recorded local tokens. Its v2 accounting excludes the mirrored maker model-call rows. These are recorded totals with incomplete paths, not proof of complete ecosystem usage. Current runtime scorecards correctly leave dollars unknown where model/price/split evidence is missing. Reuse that treatment instead of the Mission Control curve's fallback prices. [Runtime queries/readers](runtime-evidence.json).

**VERIFIED — GPU energy is substantially observable.** Workstation samples cover approximately 99.9% of the seven-day window and 99.6% of included local job time. Integrated GPU energy is 10.955 kWh. Attributed jobs include:

| Consumer | Jobs | Attributed GPU energy | What it proves |
|---|---:|---:|---|
| `gym:atomic@llama-router` | 200 | 5.872 kWh | Measured R&D expenditure; production benefit is not attributed by this reader |
| Remote maker on workstation | 21 | 0.576 kWh | Measured job-window expenditure; corresponding outcome cohort is 10 successful production-maker outcomes/16 attempts |
| Committee | 7 | 0.074 kWh | Measured committee-job expenditure; not independently demonstrated downstream value |

The gym spends about 10.2 times the remote-maker job energy in this window. This is a reason to evaluate transfer and experiment stopping conditions, not a causal proof that training is wasteful. Roughly 4.43 kWh of sampled GPU energy is not assigned to these recorded finished job windows; it must not all be labeled idle or waste. The collector excludes some ongoing/boundary jobs, and attribution has limited coverage by job type. Shared GPU intervals are split equally between overlapping recorded jobs. GPU board/package energy excludes whole-host CPU/RAM, cooling, other hosts and cloud energy; `hosts[].gpu_kwh` is not a wall-plug measurement despite wording in an existing note. Tokens, money, power and energy need separate labels.

**VERIFIED — the main execution loop does close learning records.** There are 131 `loop_learning_closures`, all associated evals passed. The main repair loop has 29 closures among 41 completed runs created in the seven-day window. The other 12 completed repair runs, all older (17–19 October), have maker/checker leases but no closure. Eligibility was not independently replayed for those historical runs, so they are not automatically twelve current defects. No blocked-closure event appears in this window. The 244 completed maintenance-loop runs have no closure; deterministic housekeeping must be classified separately from an eligible agent execution rather than automatically treated as missed learning.

A closure is useful assurance bookkeeping. Its score checks maker/checker separation, gates, terminal state, traces, checkpoints and manifests, minus retry penalties. Its delta compares a previous eval of the **same run**. The 24 positive and 22 negative deltas are therefore not independent measures of intelligence, task-performance learning or between-swarm evolution. Of closure-linked memory rows, 112 are promoted, 18 rejected and one remains a candidate. That proves dispositions, not benefit on new tasks. The assignment path reads distinct promoted `engineering_rule` memories, not every generic closure memory; do not assume those 112 operational summaries are all injected into prompts.

**VERIFIED — memory and runtime feedback influence execution.** `LOOP_MEMORY_RULES_ENABLED=true`, `LOOP_BANDIT_ENABLED=true`, and the daemon actually calls the bandit and records assignment context. Memory selection uses bounded, sealed rules, outcome-linked fitness and an exploration slot. Runtime selection uses outcome-based Thompson sampling; its current pre-20-outcome challenger share is configured at 0.8, not the source's default 0.1. This is an effective setting, not a recommendation to change it mid-experiment. The bandit optimizes its recorded success signal, not a measured joint quality/token/energy objective. Weighted fitness, graded fitness, effort control and value allocation have shadow/reporting components; their presence does not mean all proposed allocation changes are applied.

**OBSERVED — the system has substantial candidate and projection state.** The database has 35 candidate and 477 deprecated swarm capabilities; Mission Control's health total of 100 is a truncated latest-100 projection. It is not the complete registry. All 212 registered missions remain observed, while their linked goals include 103 completed and 109 failed, each with a loop. The goal-decomposer source deliberately registers advisory observed missions. This is a disconnected planning projection, not evidence that 212 running swarms stalled. The generic `SwarmOrchestrationService` has zero sessions and its execution method explicitly throws `SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED`; canonical maker/checker execution nevertheless exists through goals/loops. Extend that existing execution path rather than building a competing session runner.

## Do the current comparisons show improvement?

The following are existing registered readouts, not new experiments launched by this audit. [Learning evidence](learning-evidence.json) retains their current readers and SQL.

| Existing comparison | Current evidence | Supported conclusion |
|---|---|---|
| Memory rules versus withheld rules | 55/73 verified among settled rule runs; 31/35 among settled holdouts; Fisher p=0.1316 | No demonstrated benefit from the current comparison. The rules arm's lower point estimate is not proof of harm. Both arms reached the registered 30-outcome target; the registry marks a readout overdue |
| X1 siblings on versus off | 34/44 verified among settled on-goals; 43/58 off-goals; Fisher p=0.8178 | Additional sibling benefit remains inconclusive. Counts are below the registered 94 settled outcomes per arm |
| Genome trials | Eight recorded decisions: two blind, six no-headroom; one active genome in registry | Trial/selection mechanisms exist; this snapshot does not establish repeated successful promotion of improved swarm configurations |
| Outcome-learning assessments | Current reader produces observational signals while causal support is explicitly false pending authoritative experiment binding. Two older September falsified/causal-support rows remain | Do not treat sender labels or legacy rows as current causal certification. Preserve the existing fail-closed distinction |

Memory assignment consistency was checked: no run in the inspected experiment-period events had both rule injection and withheld-rule flags. Repeated assignment events exist, so event counts are not run counts. Both current comparison readers condition on settled proposal outcomes and contain exclusions; they are not all-assigned success rates, complete economic analyses or evidence for other swarm/task types. Independent effects, costs, latency, missingness and interactions with concurrent protocols remain to be assessed at the registered readout.

There are six active oracle-goal experiments against a limit of four, with two explicit grandfathered exceptions and the current guard passing. Do not add another overlapping swarm experiment before a registered study reads out. Memory-holdout is the immediate actionable readout. Existing ACE-001, STE-001, dependency preparation, sibling, checker-family and memory protocols already cover several proposed improvement mechanisms.

## How to maximize value

Use quality and required assurance as constraints, then minimize total tokens, elapsed time and measured energy for comparable work. A swarm should expand only when decomposition or an independent alternative adds measurable value beyond its coordination cost. Simpler execution remains an essential control; required independent review/security checks remain in every admissible arm. Research on controlled agent architectures supports evaluating task/architecture fit rather than assuming larger teams help. [Kim et al., v3](https://arxiv.org/abs/2512.08296v3).

For each eligible swarm configuration, make three existing loops complete: execution/recovery; outcome-to-reusable-knowledge; and controlled configuration selection with later survival. Each terminal assignment needs a recorded disposition, including failed, cancelled and inconclusive cases. Each promoted variant needs exact configuration/evidence identity, a comparison, rollback and fresh-task retest. Some swarm types will have insufficient evidence or should retire; no mechanism can guarantee that every swarm monotonically becomes smarter, faster and cheaper simultaneously.

First repair metric/projection truth, read out memory-holdout, expose per-configuration resource/outcome coverage, then fill the demonstrated missing feedback connections. Extend current services and surfaces. Do not add a swarm-learning database, another generic registry or a continuously chatting supervisor population.

Validation: 85 existing focused tests passed, two canonical-knowledge tests skipped because the external knowledge checkout was absent; one audit-only HTTP reproduction passed. The initial resource test could not load because the temporary shared-source alias incorrectly captured `/jwt`; fixing only the audit alias made its ten tests pass. This was a local harness problem, not an application failure. No full CI, native execution experiment, protected gate edit or deployment was performed. See [evidence and limits](evidence.md).

## Repository note (2026-10-25)

Screenshots and page-text captures (`*.png`, `*.txt`) are kept outside this public repository (they contain account details). SW-04: the memory-holdout readout is registered as a single analysis at stop_by 2026-10-27 and runs then — not earlier.
