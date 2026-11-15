# M0 — H5 / H6 / H10 and the four evolution links (§11)

## Scope and commits

- **Source read:** origin/main `7758d153e415177de8e977721011c9675482934c` (2026-11-14 20:05 +0100, #1263), detached worktree.
- **Running version:** prod `/health` commit = build.commit = built_commit = `7758d153…`, `commit_matches_build: true`, build_time 2026-11-14T19:25:26Z (deploy-vps.sh). So the source, the built artefact and the running version are the same commit.
- **Prod data:** read-only `better-sqlite3 {readonly:true}` against `/data/djimitflo.sqlite` in `djimitflo-live`. The temp scripts were removed after each run. Window "30 d" = `created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')` = 2026-10-15T20:35Z → 2026-11-14T20:35Z, unless stated otherwise.
- **Prod env (container `env`, relevant flags):**
  - GENOME_APPLY_MODE **unset (= off)**, DREAM_EVOLUTION_ENABLED=true, DREAM_PROMOTION_RULE=both, GRADED_FITNESS_MODE=shadow, GENOME_FIRE_CHECK=true.
  - LOOP_MEMORY_RULES_ENABLED=false, MEMORY_HOLDOUT_RATE=0.3, LOOP_SKILL_CARDS_ENABLED=true, SKILL_DISTILLATION_MODE=shadow.
  - SKILL_ROUTE_MODE=shadow, SKILL_FIRST_MODE unset (off), ACE_001_MODE=on, KB_CONTEXT_ENABLED=true, CAPABILITY_FACTORY_MODE=on.
  - PL_001_MODE=on, PROCEDURE_SELECTOR_MODE=shadow, SETTLEMENT_EXECUTION_MODE=shadow, FAIL_BEFORE_PASS_AFTER_MODE=shadow, WEAK_ASSERTION_CHECK_MODE=shadow.
  - LOOP_BANDIT_ENABLED=true (species `opencode,remote@workstation/atomic@llama-router`), LOOP_AUTO_MERGE_TEST_ONLY=act, LOOP_AUTO_MERGE_VALUE_GATE=on (lane exports).
  - SELF_IMPROVEMENT_REFINEMENT_ENABLED=false, DISCOVERY_RELEVANCE_PAUSED=true, FRONTIER_EXPERTS_SCHEDULER_ENABLED=false, BENCHMARK_SCHEDULE_MODE=on.

## Per-hypothesis table

| id | status | evidence level | evidence (summary; details below) | uncertainty |
|---|---|---|---|---|
| H5 | **BEVESTIGD** | CODE + TEST + RUNTIME | No production artefact class has delivery receipt → use evidence → credit end to end. Gym genomes prove delivery: the fire check found all lines in 688/688 attempts. Production makers get only a whole-prompt 16-hex `prompt_hash` (316/316 leases). The prompt text is not kept, so membership of a rule, page or example cannot be re-verified. Verified-use = 0 for every class. memory_rule and example credits are issued on delivery alone (108 + 197 in 30 d); a test asserts this. | Whether makers read the blocks is unknowable from current data. Remote transcripts are "unobservable" by design. |
| H6 | **BEVESTIGD** | CODE + RUNTIME | The bandit reward is `skill_outcomes.success` = allGatesPassed, which includes the LLM checker's accept: pre-settlement, binary, all-time window. The genome reward is executed gym tests on a frozen holdout (binary; graded is recorded only). The retention label (merge survival) cannot fail: 110/110 SETTLED_SURVIVED, 0 regressed. Shadow settlement execution gives 110/110 `pass`. | The graded/FBPA signals exist but nothing reads them as reward. |
| H10 | **GEWIJZIGD** | RUNTIME + CODE | All 218/218 proposals in the last 30 d came from `gap_analysis` (oracle lanes). The other sources made 0 proposals: refinement (last 09-29), reflection (last 09-30), feedback (last 10-08), discovery (paused; 0 new expert claims/evidence/repos), conversations (0 discussion turns ever; 1 838 agent_messages, 0 proposals). They are not growing; they are switched off. Net value is the oracle-lane funnel 218 → 115 verified → 94 merged → 49 settled → 49 survived (survival cannot fail). Maker tokens: 123.3 M (ledger), 130.8 M (skill_outcomes). | Lane split is a LIKE heuristic on evidence_refs. Gym tokens are mostly unrecorded. |
| REWARD | **partial** | RUNTIME (benchmark) + CODE | The security checker rejects plausible-but-wrong code on a fixed set: SEC-F1 2026-11-14 AUC 0.952, 19/20 caught, 2/26 false rejects, KEEP. But the labels that learners select on cannot reject weak work: verified passes weak tests (FBPA shadow fail 38/80 decisive; graded mutant-kill mean 0.325), and survival/settlement never fail. | SEC-F1 contamination and small n (see below). |
| VARIATION | **partial** | RUNTIME | Variants reach the gym runtime (fire check 688/688). They reach no production maker: GENOME_APPLY_MODE off, 0 `genome_apply` receipts ever, 0 active non-baseline genomes. | — |
| RETENTION | **untested** | RUNTIME | Nothing has ever been promoted: 0 active genomes, 0 validated skills, memory rules off since 10-26/27, PL procedure retired. So "stays used after restart" has never been observed. | Code reads promotions from the DB on each assignment, which should survive a restart (CODE only). |
| SELECTION | **partial** | RUNTIME | Worse/equal variants are rejected: 7/7 powered trials in 30 d were retired, 0 promoted, 0 inconclusive; the PL procedure was retired (b 1 / c 5). "Better is chosen" has never been observed: 0 promotions ever, max b−c = 3. One trial had graded `promote` (p 0.031) and was not acted on under rule `both`. | Power: 38 deciding tasks with c ≥ 2 in every trial. A one-sided McNemar at α 0.05 needs e.g. b ≥ 5 with c = 0, or b 7 with c 1. |

## H5 — registration → delivery → receipt → use → credit, per artefact class

All production maker text is `LOOP_WORK.md`. It is written at `loop-service.ts:2468-2487` (`renderWorkAssignment`, `:319-349`, plus `assignmentContextMarkdown`, `assignment-context.ts:137-150`) and read verbatim as the runtime prompt at `loop-worker-executor-service.ts:331`. Its sha256 (first 16 hex) is stored on the lease as `prompt_hash` (`loop-worker-executor-service.ts:784`, `reviewer-independence-service.ts:49`).

The `assignment_packet_sha256` receipt plus its content-addressed copy (`loop-service.ts:2761-2768`) covers the JSON packet. The packet includes `advisory_context` but **not** rules, KB pages, examples or capabilities (`loop-service.ts:2489-2555`). LOOP_WORK.md itself is not retained.

Prod 30 d: 316 production maker leases (`doc-drift-and-small-fix-loop`: opencode 234, remote 64, claude 13, codex 5). 316/316 carry `prompt_hash` and 218/316 carry `assignment_packet_sha256`. There were 296 `assignment_context` events.

| class | registration | delivery point (file:line) | receipt | evidence of use | credit | prod 30 d: delivered / receipts / verified-use |
|---|---|---|---|---|---|---|
| Memory rules (engineering_rule) | `memory_candidates` status promoted: 29 engineering_rule. The 173 promoted operational_memory rows are never served to makers. | `assignment-context.ts:86-110` (top 3 by M5 fitness, sealed sha) → markdown `:140` | `memory_access_log` row written at selection (`:108-109`, before the file is written); `rule_ids` on the event (`loop-service.ts:2479-2481`); rule sha prefix inside the text; lease `prompt_hash` covers only the whole text. | **none** (no transcript or adherence check) | `outcome_credits` memory_rule for every rule id on the event of a verified run (`outcome-attribution.ts:243-245`; asserted by `__tests__/outcome-attribution.test.ts:187-196`) | 104/296 events carried rules, all ≤ 2026-10-26T22:44Z (off since); 49 withheld. 312 access-log rows; 316/316 prompt_hash (whole text). **Verified-use 0.** 108 credits on only 3 distinct rules (36 each). |
| Proven examples (K1 / ACE-S) | verified test-gap `self_improvements.grounding_json.artifactPath` | `assignment-context.ts:60-64` (recency) / `:69-72` (ACE-001 S similarity) | paths in event `examples` | none | `example` credit on delivery (`outcome-attribution.ts:246`) | 216/296 events; **verified-use 0**; 197 example credits |
| Distilled skill cards (`skill_cards`, SKILL_DISTILLATION_MODE=shadow) | 230 cards, all lane `doc-drift-and-small-fix-loop` (88 skill survived, 77 skill candidate, 65 anti_pattern candidate) | **never delivered to a maker** (no reader in assignment-context; `fitness-contracts.ts:242` "never injected"). Consumed only by the dream evidence pack (`dream-evidence-sources.ts:50`, DREAM_EVIDENCE_SOURCES=skills,anti_patterns,knowledge) → genome citations | genome `evidence_sources_json` (cites = 1 on all 7 epoch-1 trials) | n/a | n/a | 0 / 0 / 0 to makers |
| Executable skills (fleet task path) | skill packages / `skill_artifact_versions` (0 rows) | `execution-engine.ts:1580-1600` (receipt writer) | `execution_evidence` reason `skill_delivery_receipt` with delivered_sha256 / assignment_sha256 | test_result evidence bound to the package hash (`:1608-1625`, SKILL_FIRST_MODE=on only) | `skill_delivery:delivered` refs | 0 receipts ever; fleet skill_outcomes 285, 0 with `skill_delivery:delivered` |
| Oracle-gate skill route (L1) | `swarm_capabilities` `skill:oracle-gate` v `e8488417a014`, **status candidate** (2026-11-06). Its digest equals `scripts/skills/oracle-gate.mjs` at origin/main (sha256 e8488417…). | `assignment-context.ts:113` → `skillRouteFor` (`skill-route.ts:250-265`); `liveSkills` needs status **validated** (`:214-216`), and the block is delivered only in mode `on` (`:262`) | event `skill_route` + `assignment_sha256` of LOOP_WORK.md (`skill-route.ts:268-271`, `loop-service.ts:2481`) | opencode JSONL transcript scan for a `bash` run of the script (`skill-route.ts:302-345`) | `skill_invoked` only if on ∧ treatment ∧ delivered ∧ invoked ∧ digest ok ∧ checks pass ∧ verified (`:350-354`, `outcome-attribution.ts:237`) | **0 / 0 / 0**. 0 events carry `skill_route`: the capability is not validated, and the mode is shadow. |
| Genomes / strategy lines — production | `maker_genomes`: 0 active non-baseline (1 baseline, 18 retired, 6 inconclusive, 3 trial) | `loop-daemon.ts:685-687` → `genome-apply.ts:99-125` (GENOME_APPLY_MODE=on only); attribution stamp `loop-daemon.ts:689-707` | lease `genome_apply` {lines_sha256, assignment_sha256, delivered} | outcome only (holdout contrast, auto-retire `genome-apply.ts:180+`) | `genome` credit from the lease stamp (`outcome-attribution.ts:235-236`) | 0 `genome_apply` / `genome_delivery` / `genome_undelivered` ever. 5 leases stamped `genome_id=baseline` (no lines) and 1 `strategy:baseline` credit in 30 d (3 ever): a credit for a genome that has no content. |
| Genomes — gym | trial genomes | gym LOOP_WORK.md; fire check `remote-gym-service.ts:455-456`, `genome-registry.ts:294-299` | `gym_result.fire_check` {goal_sha256, genome_lines, genome_lines_found}; VOID without it | paired outcome vs parent on frozen holdout (no adherence check) | McNemar promotion (`dream-evolution.ts:667-680`) | 30 d: 688/688 non-baseline attempts with a fire check had **all** lines found; 75 discarded without one. Use = outcome only. |
| Capability-factory entries | 1 factory capability (candidate) | `assignment-context.ts:111-112` (`factoryCapabilityLines`) | event `capabilities` / `capability_ids` | none | none | 0/296 events |
| KB pages / retrieval | `kb_pages` 1 313 (11 quarantined), last `updated_at` **2026-10-06** | maker side: ACE-001 R arm `assignment-context.ts:74-77` → "Related Knowledge" block `:141-142`; panel side: kbContext under jev `kb_passage_relevance` enforce | `ace_001.kb_paths` in event + lease `ace_001` | none | `knowledge` credit only from the proposal's evidence_refs (`outcome-attribution.ts:248-254`), never from delivery | maker: 144/296 events carried kb_paths; **verified-use 0**; 0 `knowledge` credits ever. Panel: 57 relevance judgments (54 yes / 3 no). |
| Procedure lines | `maker_genomes` origin procedure `ts-build-error-repair-v1` (retired 10-30) | PL-001 gym arm B only (`procedure-selector.ts:59` "never a production maker") | PL fire check (mandatory both arms) | paired McNemar | lifecycle rule | 0 production. PL-001: 60 pairs, b 1 / c 5, p 0.984 → retired. |
| Advisory past experience | experience retrieval | `loop-service.ts:2405-2432` | its sha256 sits in a worktree control file and in the packet (packet sha on the lease) | none | none | not separately counted |

**H5 verdict:** BEVESTIGD. Registration and selection are logged for every class. Delivery is provable only for gym genomes (fire check) and, by design but inactive, for the skill route and genome-apply. Use is observed for no class. Two classes (memory_rule, example) are **credited on delivery**. Code applies the NE-002 rule "no credit for delivery" (`skill-route.ts:22`) only to the skill route.

## H6 — reward and retention definitions (recomputed)

| learner | reward definition (code) | kind | window | prod now |
|---|---|---|---|---|
| Maker bandit | `skill_outcomes.success` of `loop-maker:<loop>:<runtime>` (`runtime-bandit.ts:41-42`). It is written as `allGatesPassed(verification.gates)` (`loop-daemon.ts:948,1018`), which includes the LLM checker's accept. It drops unfair zeros (`runtime-bandit.ts:20-21`: infra_failed, no_change, evolve:lost_eligible) and non-maker zeros (`nonMakerRunSql`). | verified label, binary, **pre-settlement**, not graded, cost ignored | **all-time**, no decay | 30 d outcomes: opencode 102/213 ok (41 unfair zeros), remote@workstation/atomic 16/43 (1 unfair). `bandit_selected`: opencode 439, remote 3. |
| Genome trials | `gym_result.status` = success on the frozen holdout, eligible only with prod gates (`genome-registry.ts:281-282`); discordant b/c → one-sided McNemar < 0.05, mined c−b ≤ 1, scope, ≤ 1/day (`dream-evolution.ts:667-680`). Graded scores are recorded (`:670-675`) and decide only under `graded`; prod `both` = McNemar, with the e-value recorded. | executed oracle (tests green), binary; graded shadow | frozen epoch (epoch 1: 38 deciding tasks) | 30 d evolution-gym runs 1 079: 383 success / 533 failure / 162 discarded / 1 null |
| Memory fitness (M5) | +1 for a verified run that read the rule, −1 for a regressed one unless non-maker (`assignment-context.ts:88-100`) | verified label | rules ≤ 14 d old or fitness > 0 | inactive since 2026-10-26/27. Recomputed holdout (events 10-08T19:22 → 10-27, verified vs regressed goals): rules 68/97 = 70.1 % vs withheld 34/47 = 72.3 % (no benefit, in line with the EXP-3 falsification) |
| Retention (merge survival) | survived = share of added lines still on main at +14 d ≥ minRetained (`merge-survival.ts:281`, states `:46-70`) | line retention, no execution | 14 d | all-time: **110 SETTLED_SURVIVED / 0 SETTLED_REGRESSED**; 60 merged pending; 14 + 5 closed unmerged; retained = 1.0 in 108/110 |
| Settlement execution (shadow) | re-runs the maker's test files on main at +14 d and scores a fresh-mutant kill share (`settlement-execution.ts:15-40`) | executed, plus graded kill_share_now | +14 d | 110 rows (10-22 → 11-13): **110 pass**, 0 fail/removed/unknown; kill_share_now mean 0.416 (n 93) |
| Graded / FBPA / assertion strength (shadow, maker time) | `metadata.graded`; `test:fail-before-pass-after` and `test:assertion-strength` checks, status `skipped`, verdict in shadow_status | executed, not read by any learner | — | 30 d: mutant_kill n 79, mean 0.325; mutation_score n 35, mean 0.882. FBPA: 38 fail / 42 pass / 17 skipped. Assertion strength: 5 fail / 141 pass / 10 skipped |

## H10 — 30-day sources → verified → merged → survived, plus tokens

| source | proposals | verified | merged | settled | survived | maker tokens (skill_outcomes) |
|---|---|---|---|---|---|---|
| gap_analysis / mutation-gap | 100 | 33 | 29 | 18 | 18 | 85.2 M (≈ 4.7 M / survivor) |
| gap_analysis / exports | 76 | 58 | 52 | 27 | 27 | 25.7 M (≈ 0.95 M / survivor) |
| gap_analysis / test-gap | 30 | 21 | 10 | 4 | 4 | 14.7 M |
| gap_analysis / finding-fix | 12 | 3 | 3 | 0 | 0 | 3.7 M |
| refinement / reflection / feedback | 0 (last 09-29 / 09-30 / 10-08) | — | — | — | — | — |
| discovery / experts | 0 proposals; 0 new expert_claims / expert_evidence / discovered_repositories; 0 discovery_relevance judgments (paused); 0 verified proposals ever cite expert/kb/okf/discovery refs | | | | | jev total 0.90 M |
| agent conversations | 0 discussions / turns (turns: 0 ever); agent_messages 1 838 (evidence-room 1 369, deerflow 233, hermes-eve-v 226, agent-commons 10) → 0 proposals | | | | | not attributed |

The 30 d status breakdown of the 218 proposals is 115 verified, 64 regressed, 32 infra_failed, 4 archived, 3 no_change.

Ledger (`llm_model_calls` 30 d):
- maker 123.3 M (24 calls unknown)
- checker 2.3 M
- jev 0.90 M
- content_safety 0.49 M
- evolution_gym (subscription) 0.31 M
- panel 0.21 M
- `gym` 718 calls with **tokens unknown for all 718**; skill_outcomes gym: 659/881 unknown

So a genome trial's cost cannot be computed.

## Evolution links (§11)

- **REWARD — partial.**
  - On a fixed set, the security checker rejects plausible-but-wrong code. SEC-F1 benchmark run `sec-f1:936eac4fa90f8f45` (2026-11-14 13:51–13:59Z, operator_runner, glm-5.2, prompt dd101494…, 1.88 M tokens): AUC **0.952** (CI 0.883–1.0), 19/20 caught, **2/26 false rejects**, which is exactly the KEEP limit of ≤ 2. Decision KEEP.
  - History: 2026-10-21 AUC 0.975, 19/20, 0/26 (`docs/research/eco/SEC-F1_RESULT.md`). Two runs on 11-13/14 aborted with a harness fault (exit 4, > 2 no-verdicts).
  - Limits: contamination (public advisory fixes), n 46, small diffs, one model. It measures the security reviewer only. It is not the label the learners select on.
  - The learners' labels do not reject weak work:
    - verified includes tests with FBPA shadow fail (38 of 80 decisive) and low mutant-kill (mean 0.325);
    - survival (110/110) and settlement execution (110/110 pass) never fail.
  - The graded kill share is the one executed, continuous signal, and it is shadow-only (except for the exports value gate and the CV/PL secondary measure).
- **VARIATION — partial.** DREAM_EVOLUTION_ENABLED=true. 10 dream genomes created in 30 d (7 settled + 3 in trial). They reach the gym maker (fire check 688/688). GENOME_APPLY_MODE is unset (off): 0 `genome_apply` receipts ever, and no production maker has received a non-baseline genome.
- **RETENTION — untested.** No promoted artefact exists to retain:
  - 0 active non-baseline genomes, 0 validated skill_from_repair capabilities;
  - memory rules have been off since 10-26/27; the PL procedure was retired 10-30.
  - The code path for retention is a DB status read on each assignment (`strategyGenomeFor` `genome-registry.ts:325-330`, `liveSkills` `skill-route.ts:214`). That is CODE only.
  - The code-retention label (merge survival) cannot discriminate.
- **SELECTION — partial.** Genome trials in 30 d: 7 settled (all `powered`, epoch 1), **0 promoted, 7 retired, 0 inconclusive**, 3 trial genomes pending (`g-80522e87`, `g-0a715d92`, `g-99ac32a2`, 11-12).
  - Discordant pairs: 4/3, 5/2, 5/5, 5/2, 5/3, 5/2, 4/3 (p 0.227–0.623).
  - `g-d14c1156` had graded `promote` (0.721 vs 0.612, p 0.031). Under `graded` it would have been promoted on 10-31; under `both` it was retired.
  - Before that: 6 inconclusive (no_headroom) and 2 blind (epoch 0, 10-06…10-09). PL-001 retired its procedure (b 1 / c 5).
  - The bandit selects on the pre-settlement verified label: 439 vs 3 choices for opencode.
  - Rejection works. Choosing a better variant has never happened (0 promotions ever).

### The ONE smallest complete evolution cycle (§11) and its preconditions

**Cycle: the L1 oracle-gate skill route on the oracle lanes (mutation-gap, test-gap, exports) for opencode makers.** The variant is skill `oracle-gate@e8488417a014` delivered to the treatment arm; the control is the 50 % per-goal sha256 holdout (`skill-route.ts:226-228`).

This is the only production path where every link of the H5 chain already exists in code and is tested (`__tests__/skill-route.test.ts`):
- registration digest
- delivery block sha256 + LOOP_WORK.md sha256 on the event
- transcript invocation (opencode JSONL is observable)
- daemon-executed checks
- verified
- credit only for actual use

It runs on a real recurring task: 218 oracle-lane goals in 30 d, and opencode ran 234/316 maker leases, so each arm and lane reaches n ≈ 30 in about 2–3 weeks for mutation-gap/exports.

Preconditions:
1. An operator validates `skill:oracle-gate` (status candidate → validated). The digest already matches origin/main.
2. `SKILL_ROUTE_MODE=on`.
3. A pre-registered decision rule and stop, which code lacks today (fitness contract `skill_route` decision_rule null). For example: at n ≥ 30 settled per arm per lane, keep if the treatment verified-rate lower bound > holdout, otherwise retire the capability. The outcome must be executed, i.e. verified plus settlement `kill_share_now`, not merge survival.
4. A retention check: after the next deploy/restart, `assignment_context.skill_route` receipts keep naming the same capability version.
5. Experiment collisions: ACE-001 / STE-001 / MAKER-DEPS-001 / memory-holdout arms are hashed independently (skill-route salt). The pre-registration should still stratify by those arms.

The second option is GENOME_APPLY_MODE=on. Its code is more complete (holdout, receipt, auto-retire), but it has no input until a gym promotion happens (0 ever). Remote@workstation makers, the only species it can reach, got 3 of 442 bandit choices in 30 d, and auto-retire needs ≥ 20 settled delivered outcomes.

## Confirmed defects

| # | defect | smallest fix (files) | test that fails today | risk | blocks M1? |
|---|---|---|---|---|---|
| D1 | `memory_rule` and `example` credits are issued for delivery, not use (`outcome-attribution.ts:243-246`). `evolution-feedback.ts:87-90` publishes them as "most credited patterns", and `knowledge-fitness.ts:124` reads them. This contradicts NE-002. | In `creditedContributors`, emit them as `memory_rule_delivered` / `example_delivered`, or drop them until a use receipt exists. Filter the same in evolution-feedback and knowledge-fitness. | `outcome-attribution.test.ts`: a verified run whose assignment_context has `rule_ids:['rA']` and no use receipt must yield **no** `memory_rule` credit. Today the test at `:187-196` asserts the opposite. | low (readers are digest/shadow) | Only if M1 cites credits as evidence of use. Otherwise no. |
| D2 | The retention label cannot fail: merge survival 110/110, settlement execution 110/110 pass. | Make retention executed: e.g. merge-survival marks SETTLED_REGRESSED (or not_scored) when the shadow settlement_execution verdict is fail/removed, and report `kill_share_now` next to it (`merge-survival.ts:281`, reading `settlement-execution` rows). | A merged PR whose test file was deleted on main (settlement verdict `removed`) while > 50 % of its other added lines remain is SETTLED_SURVIVED today; it should not be. | medium (changes the merge skill_outcomes the dashboards read) | **Yes** for any selection on retention. |
| D3 | There is no per-block content receipt for rules, KB pages, examples or capabilities on production makers. `prompt_hash` is 16 hex of the whole LOOP_WORK.md, which is not retained. The packet copy lacks these blocks. | In `writeWorkAssignment` (`loop-service.ts:2477-2487`), add `assignment_sha256` plus per-block sha256 to the assignment_context event, as `skillRouteEventMeta` does, or store a content-addressed copy of LOOP_WORK.md as `withAssignmentPacketProvenance` does (`:2761-2768`). | After `writeWorkAssignment` with 2 rules and 1 KB page, the event's `assignment_sha256` must equal sha256 of the written file, and `blocks.rules` must equal sha256 of the rules block. Neither exists today. | low | **Yes** for any H5 "used" claim. |
| D4 | A `strategy:baseline` genome credit is given (`outcome-attribution.ts:236`) for a genome with no lines (1 in 30 d, 3 ever). | Skip `BASELINE_GENOME`. | A verified run with `genome_id='baseline'` must give no genome credit. | trivial | no |
| D5 | Stale self-description: `fitness-contracts.ts:114` says "DREAM_EVOLUTION_ENABLED off in prod since 09-10". Prod has it true, with 7 trials in 30 d. | Correct the note. | none (prose) | trivial | no |
| D6 | Gym tokens are not recorded: `llm_model_calls` consumer `gym` has 718/718 unknown, and skill_outcomes gym 659/881. The cost per genome trial cannot be computed. | Record `gym_result.tokens` into the ledger where the worker reports it (`remote-gym-service.ts:461` `reportedTokens`). | A gym result with tokens 1234 must produce a ledger row with tokens 1234. | low | no (blocks cost-per-variant only) |

`skill:oracle-gate` sitting in `candidate` is an operator precondition, not a defect.

## Open questions

1. §11 cites "F1 history": `benchmark_runs` has only `sec-f1` (3 rows, 1 ok) and `gym-holdout` (1 row: baseline pass rate 0.451, n 82). No F1-R row exists, so the F1-R history is NIET VERIFIEERBAAR.
2. Is the gym trial design powered to promote anything? Every epoch-1 trial had c ≥ 2 on 38 deciding tasks. Is that noise (nondeterminism) or real regressions? GYM_CANARY_RATE 0.05 data could answer it; I did not compute it here.
3. Should `graded` (which would have promoted g-d14c1156) be the rule? That is an operator decision under NE-001; I make no recommendation here.
4. The bandit uses an all-time, binary, pre-settlement reward with 439:3 exploitation. Is a per-lane bandit intended? Today all lanes share loop `doc-drift-and-small-fix-loop`.
5. KB pages were last updated 2026-10-06. Is the KB sync stopped? It matters for the ACE-001 R arm (144 deliveries in 30 d).
