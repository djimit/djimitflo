/**
 * Fitness-contract registry (read-only, declarative): which Djimitflo components can actually learn. A component learns only
 * when an executed outcome that the component does not produce itself scores it against a fair comparison (a randomised arm,
 * a frozen holdout or a fixed benchmark) and a decision rule acts on that score. Everything else is measured without
 * selection, scored by its own output (circular), or not measured at all.
 *
 * One entry per component class. Each entry states what the code does today — not what a design document intends — with the
 * file references in the comment above it. Nothing here changes behaviour: no flag, no assignment, no prompt, no gate.
 *
 * Reuse, not duplication: flags are EVOLUTION_FLAGS names (evolution-evidence.ts), experiments are experiment-registry.ts ids,
 * mechanisms are learning-ledger.ts keys, judgments are JudgmentDef ids (services/judgments/*, decision-context-service.ts,
 * kb-corpus.ts). The CI test (fitness-contracts.test.ts) pins every acting flag and every judgment to a contract.
 */
import type { LearningStatus } from './learning-ledger';

export const FITNESS_STATUSES = ['closed_loop', 'measured_no_selection', 'unmeasured', 'circular'] as const;
export type FitnessStatus = (typeof FITNESS_STATUSES)[number];
export type FitnessComparison = 'randomised' | 'holdout' | 'benchmark' | 'none';
/** independent = an executed outcome the component does not produce; circular = scored by its own (or its family's) verdict; none = no outcome */
export type OutcomeIndependence = 'independent' | 'circular' | 'none';
export type FitnessClass = 'maker' | 'reviewer' | 'judgment' | 'skill' | 'memory' | 'knowledge' | 'expert' | 'discovery' | 'forecaster' | 'gym' | 'lane' | 'merge';

export interface FitnessContract {
  component: string; class: FitnessClass; name: string;
  /** what one scored unit is */
  unit: string;
  /** EVOLUTION_FLAGS names that steer this component */
  flags: string[];
  /** JudgmentDef id, for a judgment contract */
  judgment?: string;
  /** experiment-registry.ts id that measures it */
  experiment?: string;
  /** learning-ledger.ts mechanism key */
  mechanism?: string;
  outcome: { metric: string; source: string; independence: OutcomeIndependence };
  /** where each cost is recorded; null = not recorded for this component */
  cost: { tokens: string | null; kwh: string | null; operator_minutes: string | null };
  comparison: { kind: FitnessComparison; ref: string | null };
  /** the rule that acts on the measurement; null = nothing acts on it */
  decision_rule: string | null;
  /** how a win propagates; null = it does not */
  inheritance: string | null;
  status: FitnessStatus;
  note: string;
}

export const judgmentFlag = (id: string): string => `TYPESAFE_${id.toUpperCase()}_MODE`;

/**
 * "verified" below is self_improvements.status / skill_outcomes.success as the loop daemon writes it: allGatesPassed over the
 * run's gates (loop-daemon.ts outcomeVerified) — deterministic checks, scope and diff gates AND the LLM checker's accept
 * (loop-verification-service.ts checker_verdict). It is not the maker's own output, so it counts as independent of a maker,
 * but it is a pre-settlement proxy that embeds the checker; merge survival (merge-survival.ts) is the settled signal.
 */
const VERIFIED = "verified = allGatesPassed (self_improvements.status / skill_outcomes.success; embeds the LLM checker's accept)";
const MAKER_TOKENS = 'skill_outcomes.tokens_used + llm_model_calls (recordMakerCall; null where the runtime reports no usage, maker-token-accounting.ts)';
const JUDGMENT_TOKENS = 'judgments.input_tokens / output_tokens / latency_ms (a missing usage report is written as 0, judgment-service.ts)';
const NO_COST = { tokens: null, kwh: null, operator_minutes: null };
const LANE_TOKENS = 'worker_leases.metadata.token_accounting per run; no per-lane roll-up exists';
/** fresh-mutant kill share at settlement: mutants seeded at the merge sha, maker-time mutants removed (settlement-execution.ts) */
const SETTLED_KILL = "fresh-mutant kill share at +14 d (judgments 'settlement_execution' answers_json.kill_share_now; SETTLEMENT_EXECUTION_MODE=shadow)";

const judgment = (id: string, c: Omit<FitnessContract, 'component' | 'class' | 'judgment' | 'cost' | 'flags' | 'inheritance'> & { flags?: string[]; cost?: FitnessContract['cost'] }): FitnessContract =>
  ({ component: `judgment:${id}`, class: 'judgment', judgment: id, inheritance: null, ...c, flags: [judgmentFlag(id), ...(c.flags ?? [])],
    cost: c.cost ?? { tokens: JUDGMENT_TOKENS, kwh: null, operator_minutes: null } });

export const FITNESS_CONTRACTS: readonly FitnessContract[] = [
  // ── makers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // runtime-bandit.ts chooseSpecies (Beta-Bernoulli Thompson, PROMOTE_AFTER 20, maxShare cap below it); loop-daemon.ts bandit_selected
  // (posterior + chosen logged, propensity not logged — replayed by bandit-propensity.ts); reward = skill_outcomes.success of
  // loop-maker:<loop>:<runtime> minus unfair zeros (UNFAIR_ZERO_SQL, nonMakerRunSql); fitness-view.ts (merge survival) is shadow only
  { component: 'maker_species', class: 'maker', name: 'Maker species (bandit)', unit: 'one maker lease of a goal run (runtime@model)', mechanism: 'species_selection',
    flags: ['LOOP_BANDIT_ENABLED', 'LOOP_BANDIT_SPECIES', 'LOOP_BANDIT_MAX_SHARE', 'REMOTE_MAKER_ENABLED'],
    outcome: { metric: `${VERIFIED}, unfair zeros (infra / no change / evolve loser / non-maker attribution) dropped`, source: "skill_outcomes.success where skill_id = 'loop-maker:<loop>:<runtime>'", independence: 'independent' },
    cost: { tokens: MAKER_TOKENS, kwh: null, operator_minutes: null },
    comparison: { kind: 'randomised', ref: 'Thompson draws per run; propensities replayed by banditOpe (bandit-propensity.ts), no registered experiment' },
    decision_rule: 'per run: highest Beta(1 + ok, 1 + fail) sample wins; a challenger under 20 outcomes gets the run only with probability LOOP_BANDIT_MAX_SHARE when it samples best; from 20 outcomes uncapped',
    inheritance: null, status: 'closed_loop',
    note: 'The one acting selector on outcomes, but on a pre-settlement proxy that embeds the LLM checker; cost is ignored. Arms are a fixed config list (nothing new is bred). No estimate of bandit vs no bandit (ledger NOT_MEASURED); banditOpe scores raw success without the unfair-zero filter the bandit uses.' },
  // evolve-selection.ts / evolve-fitness-service.ts (hard gates, then mutation score, diff size, tokens, finish time); effort-controller.ts
  // effortX1Evidence; experiment-registry.ts X1 (stop_by 2026-11-06, verdict null); losers write success 0 (1 under GRADED_CONTEST_MODE=act)
  { component: 'evolve_siblings', class: 'maker', name: 'Evolve siblings', unit: 'one oracle-lane goal (siblings on vs off)', experiment: 'X1', mechanism: 'effort_siblings',
    flags: ['LOOP_EVOLVE_ENABLED', 'LOOP_EVOLVE_SPECIES', 'EFFORT_SIBLING_RANDOMISE', 'GRADED_CONTEST_MODE'],
    outcome: { metric: `${VERIFIED} per goal, siblings on vs off`, source: 'goals.metadata.effort_arm × self_improvements.status (effortX1Evidence)', independence: 'independent' },
    cost: { tokens: MAKER_TOKENS, kwh: null, operator_minutes: null },
    comparison: { kind: 'randomised', ref: 'X1' }, decision_rule: null,
    inheritance: "contest losers' outcomes enter the maker_species posterior (success 0, or 1 tagged contest:passed_lost under GRADED_CONTEST_MODE=act)",
    status: 'measured_no_selection',
    note: 'The per-goal winner pick (executed checks, then diff size) selects an artifact, not the mechanism. X1 is past its stop_by with no verdict; nothing acts on its readout.' },
  // ste-001.ts; experiment-registry.ts STE-001
  { component: 'maker_template', class: 'maker', name: 'Maker template (STE)', unit: 'one oracle-lane goal', experiment: 'STE-001', mechanism: 'maker_template', flags: ['STE_001_MODE'],
    outcome: { metric: `${VERIFIED}, STE vs current template`, source: "skill_outcomes 'ste-001-arm' (ste001Evidence)", independence: 'independent' },
    cost: { tokens: MAKER_TOKENS, kwh: null, operator_minutes: null }, comparison: { kind: 'randomised', ref: 'STE-001' }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'Pre-registered; the readout is an operator decision, no code switches the template.' },
  // maker-deps-001.ts; maker-warm-deps.ts (blocked_by_experiment while MAKER-DEPS-001 runs)
  { component: 'deps_prep', class: 'maker', name: 'Maker dependency preparation', unit: 'one oracle-lane goal', experiment: 'MAKER-DEPS-001', mechanism: 'deps_prep', flags: ['MAKER_WARM_DEPS'],
    outcome: { metric: 'ITT verified rate, deps prepared (B) vs not (A)', source: "loop_events 'maker_deps_arm' × self_improvements.status (makerDeps001Evidence)", independence: 'independent' },
    cost: { tokens: MAKER_TOKENS, kwh: null, operator_minutes: null }, comparison: { kind: 'randomised', ref: 'MAKER-DEPS-001' }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'MAKER_WARM_DEPS applies arm B outside the experiment and is blocked while it runs.' },
  // ── gym ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // genome-registry.ts nextTrialAttempt (parent + child on every frozen task), ELIGIBLE_GATED, fire check; dream-evolution.ts promotion
  // (b > c && McNemar p < DREAM_PROMOTION_ALPHA, mined c − b ≤ 1, scope not worse, one per day); genome-promotion.ts holdout reuse check;
  // strategyGenomeFor = attribution only, GENOME_APPLY_MODE=on injects active promoted genomes (genome-apply.ts, 10 % holdout); tg-001.ts transfer (INCONCLUSIVE)
  { component: 'gym_genomes', class: 'gym', name: 'Maker genomes (dream evolution, gym)', unit: 'one candidate genome vs its parent on a frozen holdout epoch', mechanism: 'genomes',
    flags: ['DREAM_EVOLUTION_ENABLED', 'DREAM_TRIAL_MUTANTS', 'DREAM_TRIAL_MUTANT_TIERS', 'DREAM_PROMOTION_ALPHA', 'TRIAL_HEADROOM_PRECHECK', 'DREAM_TRIAL_WRITE_TEST_HOLDOUT', 'DREAM_EVIDENCE_MUTATIONS',
      'GYM_HOLDOUT_EPOCH', 'GENOME_FIRE_CHECK', 'GYM_IRT_SELECTION', 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', 'SUBSCRIPTION_GYM_SPECIES', 'SUBSCRIPTION_GYM_MAX_PER_DAY', 'SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS',
      'GYM_ORPHAN_SWEEP', 'TG_001_MODE', 'DREAM_PROMOTION_RULE', 'GRADED_FITNESS_MODE', 'GENOME_APPLY_MODE'],
    outcome: { metric: 'gym oracle pass (tests green, source only) on production-gated eligible attempts, VOID attempts excluded', source: "loop_runs.metadata.gym_result.status (loop_name 'evolution-gym') / skill_outcomes 'loop-maker:gym:*'", independence: 'independent' },
    cost: { tokens: 'llm_model_calls (remote gym attempts) + gym_result usage where reported', kwh: null, operator_minutes: null },
    comparison: { kind: 'holdout', ref: 'gym_holdout / gym_mutant_holdout / gym_write_test_holdout (frozen epochs, paired parent vs child)' },
    decision_rule: 'promote when discordant wins b > c with one-sided exact McNemar p < DREAM_PROMOTION_ALPHA (0.05), mined regressions ≤ 1, scope violations not above the parent, ≤ 1 promotion per day; under DREAM_PROMOTION_RULE=graded a one-sided paired sign-flip permutation test on the gym graded: scores (written under GRADED_FITNESS_MODE=shadow, else 1/0) decides instead (p < α AND mean diff ≥ 0.05); holdout reuse above the limit → inconclusive',
    inheritance: 'a new mutant starts from the newest active genome; GENOME_APPLY_MODE=on delivers active promoted genomes to oracle-lane production makers of the trialled species, with a 10 % per-goal holdout and auto-retire when the holdout does better (genome-apply.ts)',
    status: 'closed_loop',
    note: 'The one sound select-and-inherit loop, closed inside the gym only. Docs record 0 promotions to date, DREAM_EVOLUTION_ENABLED off in prod since 09-10, and TG-001 (gym → production transfer) closed INCONCLUSIVE.' },
  // pl-001.ts: frozen applicable repair set, paired A/B, one-sided exact McNemar; plLifecycle → procedure 'validated' / 'retired' / 'candidate'
  // (never promoted, production delivery is a separate operator decision)
  { component: 'procedures', class: 'gym', name: 'Procedure lines (PL-001)', unit: 'one frozen repair task, with vs without the procedure lines', experiment: 'PL-001',
    flags: ['PL_001_MODE', 'PL_001_CAP_SHARE'],
    outcome: { metric: 'gated verified gym outcome per arm (infra censored)', source: "loop_runs loop_name 'pl-001' gym_result (pl001Evidence)", independence: 'independent' },
    cost: { tokens: 'pl001Evidence arms tokens (known / unknown counted apart)', kwh: null, operator_minutes: null },
    comparison: { kind: 'randomised', ref: 'PL-001' },
    decision_rule: 'at the protocol stop (60 pairs or day 14): one-sided exact McNemar SUPPORTED → procedure validated; NOT_SUPPORTED / harm → retired + negative-evidence draft; INCONCLUSIVE → stays candidate',
    inheritance: null, status: 'closed_loop',
    note: 'The lifecycle rule acts automatically, but validated is not promoted: any production delivery is an operator decision. Registered 2026-10-26, decide start or close by 2026-11-25.' },
  // cv-001.ts: frozen mutant-repair set (tiers 3–6), paired A (qwen38-27b) / B (qwen38-27b-cvd15, discipline vector 1.5) per task × repeat,
  // one-sided exact McNemar; applyCv001Verdict writes ADOPT / REJECT / INCONCLUSIVE once (REJECT → negative-evidence draft), promoted: false
  { component: 'control_vector', class: 'gym', name: 'Control-vector arm (CV-001)', unit: 'one frozen mutant-repair task × repeat, baseline vs steered router preset', experiment: 'CV-001',
    flags: ['CV_001_MODE', 'CV_001_WINDOW_UTC'],
    outcome: { metric: 'clean gated gym success per arm (VOID without the model_check delivery proof or the oracle gates)', source: "loop_runs loop_name 'cv-001' gym_result (cv001Evidence)", independence: 'independent' },
    cost: { tokens: 'cv001Evidence arms tokens (known / unknown counted apart)', kwh: null, operator_minutes: null },
    comparison: { kind: 'randomised', ref: 'CV-001' },
    decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'The verdict (ADOPT / REJECT / INCONCLUSIVE) is recorded once, with a negative-evidence draft on REJECT, but nothing acts on it: no preset is switched and no production maker ever gets the vector (gym-only arm). Registered 2026-11-07, decide start or close by 2026-12-07.' },
  // ── reviewers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  // loop-daemon.ts (checker on the maker's own runtime: "self-review"); loop-verification-service.ts checker_verdict hard gate;
  // checker-family.ts F2 (primary outcome_survival from pr_outcome settlement at >= target, else outcome_wo_checker; secondary circular)
  { component: 'checker', class: 'reviewer', name: 'LLM checker', unit: 'one checker verdict on a maker diff', experiment: 'F2', mechanism: 'checker_family',
    flags: ['LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED', 'CHECKER_FAMILY_RANDOMISE', 'CHECKER_CROSS_MODEL', 'CHECKER_FAMILY_VERSION'],
    outcome: { metric: 'kappa of the verdict with merge survival (outcome_survival, at target) or with the run relabelled without the checker gate (outcome_wo_checker)', source: 'loop_runs.metadata.pr_outcome settlement / judgments outcome_attribution failed_gates (checkerFamilyEvidence)', independence: 'independent' },
    cost: { tokens: "llm_model_calls consumer 'checker', experiment_id F2:<arm>", kwh: null, operator_minutes: null },
    comparison: { kind: 'randomised', ref: 'F2' }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'F2 computes a verdict (supported / reversed / falsified); nothing switches the checker model on it. The checker is a hard gate inside every "verified" label other components learn from.' },
  // loop-daemon.ts security checker lease; loop-verification-service.ts security_checker_verdict (required only when high risk; skipped passes)
  { component: 'security_checker', class: 'reviewer', name: 'Security checker', unit: 'one security verdict on a high-risk run', flags: ['LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED'],
    outcome: { metric: 'none: never scored against an outcome (F2 leaves it out on purpose)', source: 'none', independence: 'none' },
    cost: { tokens: "llm_model_calls consumer 'checker' (security role purpose)", kwh: null, operator_minutes: null },
    comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured',
    note: 'A gate with no fitness measurement; a skipped review counts as a pass for learners (loop-types.ts).' },
  // specialist-panel-service.ts (one oppose blocks, needs_evidence parks, goal = unanimous support ≥ 0.8 conf, ≥ 2 reviews);
  // panel-calibration-service.ts Brier per specialist; panel-attempt-metrics.ts; forecast-scoring.ts ("AUC 0.98 is leakage")
  { component: 'specialist_panel', class: 'reviewer', name: 'Specialist panel', unit: 'one proposal review (consensus of specialists)', flags: ['ORACLE_LANES_SKIP_PANEL'],
    outcome: { metric: 'Brier per specialist vs proposal outcome — observed only for proposals the panel itself authorised', source: 'self_improvements.status via panel_id (panel-calibration-service.ts)', independence: 'circular' },
    cost: { tokens: "llm_model_calls consumer 'panel_review'", kwh: null, operator_minutes: null },
    comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'circular',
    note: 'Measured, no discrimination shown: outcomes exist only where the panel said goal (selection-biased), no AUC is computed, the weighted shadow decides nothing. It vetoes (one oppose blocks) and authorises; nothing it learns changes a juror.' },
  // model-selector.ts chooseModel (≥ 20 calls, ok-rate, agreement with the incumbent's stance ≥ 80 %, then cheapest);
  // council-orchestrator.ts judge routing (evaluation.rank === 1 from LLM evaluators)
  { component: 'model_selection', class: 'reviewer', name: 'Panel / council model selection', unit: 'one model choice for a panel review or council call', flags: ['MODEL_SELECTOR_MODE', 'COUNCIL_JUDGE_ROUTING_MODE'],
    outcome: { metric: "agreement with the incumbent model's stance (panel) / relative rank by LLM judges (council)", source: 'llm_model_calls + specialist_reviews (modelEvidence); council session evaluations', independence: 'circular' },
    cost: { tokens: 'llm_model_calls cost_basis / list_price_cost / marginal_cost', kwh: null, operator_minutes: null },
    comparison: { kind: 'none', ref: null }, decision_rule: 'enforce: the cheapest candidate that parses (ok-rate) and agrees with the incumbent ≥ 80 %; council enforce: route after the cascade minimum sample', inheritance: null, status: 'circular',
    note: 'A cost minimiser scored by agreement with LLMs, not by outcomes.' },
  // committee-swarm.ts: members write forecast:committee:<member>; memberWeights; evolveCommittee retires n ≥ 30 & skill < 0, breeds the best
  // (one gene mutated); forecast-scoring.ts V1 (resolves on self_improvements.status, RESOLVED includes park states)
  { component: 'committee_swarm', class: 'forecaster', name: 'Committee swarm', unit: 'one member forecast of a proposal outcome', flags: ['COMMITTEE_SWARM_ENABLED'],
    outcome: { metric: 'Brier skill vs the source base rate (V1)', source: "judgments 'forecast:committee:<member>' resolved on self_improvements.status (forecastScores)", independence: 'independent' },
    cost: { tokens: null, kwh: null, operator_minutes: null },
    comparison: { kind: 'benchmark', ref: 'baseline:source_rate (forecast-scoring.ts V1)' },
    decision_rule: 'daily: retire a member with n ≥ 30 and skill < 0 (not the best); weight = max(0.05, 1 + 2·skill) from n ≥ 10',
    inheritance: 'the best member (n ≥ 5) gets one child with one gene mutated (knowledge recipe or a calibration line)', status: 'closed_loop',
    note: 'Selects and inherits, but on V1 scores its own doc says can fire on noise (V2 is read-only), the resolution counts panel / prescreen park states, and no decision reads the committee forecast. Rows carry no tokens (default 0, not unknown).' },
  // committee-swarm.ts arenaGate (ARENA_GATE_ENABLED: n ≥ EXTINCT_MIN_N 30 and skill < 0 → stop scheduling); forecasters.ts code forecasters
  { component: 'forecasters', class: 'forecaster', name: 'Resident forecasters (arena)', unit: 'one resident forecast (forecast:resident:<agent>)', flags: ['ARENA_GATE_ENABLED', 'SOCIAL_AUTOPILOT_FORECAST_ONLY'],
    outcome: { metric: 'Brier skill vs the source base rate (V1)', source: "judgments 'forecast:resident:<agent>' resolved on self_improvements.status", independence: 'independent' },
    cost: { tokens: null, kwh: null, operator_minutes: null },
    comparison: { kind: 'benchmark', ref: 'baseline:source_rate (forecast-scoring.ts V1)' },
    decision_rule: 'arenaGate: a resident with n ≥ 30 scored forecasts and skill < 0 is no longer scheduled', inheritance: null, status: 'closed_loop',
    note: 'Retire-only selection on V1; Gate D (decision-grade V2 skill) is report-only.' },
  // outcome-attribution.ts attributeOutcome + outcome_credits; nonMakerRunSql (read by runtime-bandit, fitness-view, assignment-context);
  // weekly seeded stratified CAR audit sample of 10, operator-labelled ("no learner reads these rows")
  { component: 'outcome_attribution', class: 'reviewer', name: 'Outcome attribution', unit: 'one settled run attributed (maker / reviewer / environment / verified)', flags: ['OUTCOME_ATTRIBUTION_ENABLED'],
    outcome: { metric: 'agreement with operator labels on the weekly audit sample', source: "judgments 'outcome_attribution' audit rows (outcome-attribution.ts)", independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'benchmark', ref: 'weekly CAR audit sample (10, seeded, stratified)' }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'Label plumbing, not a learner: it removes non-maker zeros from the bandit and memory-rule rewards. Its audit agreement is counted; nothing selects on it.' },
  // ── judgments (jev System One; judgment-service.ts judgmentMode = TYPESAFE_<ID>_MODE; thresholds are constants in each decide();
  //    no code changes a mode or threshold from measured accuracy; NE-001: jev never for approval / promotion / code / risk / fitness) ──
  // judgments/proposal-prescreen.ts; d5-no.ts (false rejection = a member verified; panel rejections count as correct); experiment D5-NO
  judgment('proposal_prescreen', { name: 'Judgment: proposal prescreen', unit: 'one proposal before the panel', experiment: 'D5-NO',
    outcome: { metric: 'false-rejection rate of confident NO (a cluster member later verified)', source: 'judgments × self_improvements.status (d5NoEvidence)', independence: 'independent' },
    comparison: { kind: 'benchmark', ref: 'D5-NO (prospective shadow audit, n 100 confident-NO clusters)' }, decision_rule: null, status: 'measured_no_selection',
    note: 'Frozen in shadow since 2026-10-11 (D5-NO); the study rule says ready / rejected, acting on it is the operator\'s. The correct-rejection side counts panel rejections, which are not oracle-grade.' }),
  // judgments/checker-second-opinion.ts; honest-numbers.ts oracleAgreement (vs the checker, and vs loop_runs.status completed)
  judgment('checker_second_opinion', { name: 'Judgment: checker second opinion', unit: 'one maker diff',
    outcome: { metric: 'kappa vs the checker verdict and vs run completion', source: 'judgments × loop_runs.status (oracleAgreement)', independence: 'circular' },
    comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'circular',
    note: 'A run completes only if the checker accepted, so the outcome it is compared with is downstream of the checker. enforce_eligible is computed and read by nothing.' }),
  // judgments/commons-contribution.ts; agent-social-autopilot-service.ts thread gate (COMMONS_THREAD_GATE_ENABLED: two 'no' in a row end a thread)
  judgment('commons_contribution', { name: 'Judgment: Commons contribution', unit: 'one Commons reply', flags: ['COMMONS_THREAD_GATE_ENABLED'],
    outcome: { metric: 'none: no ground truth for a reply\'s contribution', source: 'none', independence: 'none' },
    comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured', note: 'Acts (the thread gate) without any accuracy measurement.' }),
  // judgments/commons-idea.ts
  judgment('commons_idea', { name: 'Judgment: Commons idea', unit: 'one Commons idea',
    outcome: { metric: 'none', source: 'none', independence: 'none' }, comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured', note: 'Shadow only; no labels.' }),
  // judgments/discovery-relevance.ts; expert-source-units-service.ts (unit admission under FRONTIER_UNITS_REQUIRE_RELEVANCE); discovery-relevance-labels.ts
  // (blind DI-001 operator labels, ~7); jev-challenger.ts relevance_blind (JEV-114)
  judgment('discovery_relevance', { name: 'Judgment: discovery relevance', unit: 'one fleet discovery',
    outcome: { metric: 'none yet: agreement with blind DI-001 operator labels would score it (≈ 7 labels, none in production)', source: 'blind DI-001 operator label rows for discovery_relevance (insufficient)', independence: 'none' },
    cost: { tokens: JUDGMENT_TOKENS, kwh: null, operator_minutes: 'labelling seconds on the blind DI-001 label rows (discovery-relevance-labels.ts)' },
    comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured',
    note: 'Labelled shadow but decides expert-unit admission (a promotion, NE-001 territory); paused by DISCOVERY_RELEVANCE_PAUSED.' }),
  // judgments/failure-cause.ts; dream-state-service.ts (recurring confident causes → engineering_rule memory candidates)
  judgment('failure_cause', { name: 'Judgment: failure cause', unit: 'one failed or blocked loop run',
    outcome: { metric: 'none: DI-001 hand classes exist offline, not wired', source: 'none', independence: 'none' },
    comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured', note: 'Its recurring causes seed memory-rule candidates (the falsified memory_rules path).' }),
  // judgments/reflection-triage.ts; acts under NEEDS_GROUNDING_TRIAGE_ENABLED (value-allocator.ts GATE_READ_JUDGMENTS)
  judgment('reflection_triage', { name: 'Judgment: reflection triage', unit: 'one needs_grounding proposal',
    outcome: { metric: 'none', source: 'none', independence: 'none' }, comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured',
    note: 'Moves / archives needs_grounding proposals under NEEDS_GROUNDING_TRIAGE_ENABLED without an accuracy measurement.' }),
  // judgments/risk-atomic.ts (keyword class recorded next to it)
  judgment('risk_atomic', { name: 'Judgment: atomic risk', unit: 'one approval wait',
    outcome: { metric: 'none: only agreement with the keyword class is recordable', source: 'none', independence: 'none' }, comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured',
    note: 'Shadow; risk decisions are jev-forbidden (NE-001).' }),
  // decision-context-service.ts decisionContextJudgment (> 0.7 relevance; shadow injects nothing)
  judgment('decision_context', { name: 'Judgment: decision context (memory selection)', unit: 'one panel decision',
    outcome: { metric: 'none', source: 'none', independence: 'none' }, comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured',
    note: 'Pure cost in shadow: selections are recorded, nothing reads them.' }),
  // kb-corpus.ts gatePassages (enforce drops pages below 0.5 before the panel prompt)
  judgment('kb_passage_relevance', { name: 'Judgment: KB passage relevance', unit: 'one retrieved KB page for a panel prompt',
    outcome: { metric: 'none: 0 labels', source: 'none', independence: 'none' }, comparison: { kind: 'none', ref: null }, decision_rule: null, status: 'unmeasured',
    note: 'The one jev gate acting on prompts (enforce, constant 0.5 threshold) with no labels at all.' }),
  // ── skills ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // skill-route.ts: sha256 skill-route-holdout:v1:<goal> 50/50; credit only on delivered ∧ invoked ∧ checks pass ∧ verified;
  // skillRouteEvidence contrast descriptive, withheld below n 30 per arm; validation is a manual operator API call
  { component: 'skill_route', class: 'skill', name: 'Skill route', unit: 'one oracle-lane goal (skill delivered vs held out)', flags: ['SKILL_ROUTE_MODE', 'SKILL_VALIDATION_REQUIRES_TESTS'],
    outcome: { metric: `${VERIFIED}, treatment vs holdout`, source: "outcome_credits kind 'skill_invoked' + skill_route events (skillRouteEvidence)", independence: 'independent' },
    cost: { tokens: MAKER_TOKENS, kwh: null, operator_minutes: null },
    comparison: { kind: 'holdout', ref: 'skill-route-holdout:v1 (50 % per-goal sha256 split)' }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'No code retires or promotes a skill on the contrast.' },
  // learning-ledger.ts skillSelectionReading (per named skill success rate, Wilson from n 30, descriptive)
  { component: 'skill_selection', class: 'skill', name: 'Fleet skill selection', unit: 'one fleet agent.outcome naming a skill', mechanism: 'skill_selection', flags: [],
    outcome: { metric: 'success rate per named skill (descriptive)', source: "skill_outcomes domain 'fleet' × 'skill:<name>' refs", independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'A per-skill rate, not a skill effect. Skill cards (SKILL_DISTILLATION_MODE) are outcome-labelled but never injected.' },
  // skill-artifact-evolution-service.ts (candidate vs parent on the same pinned ≥ 30 cases, identical judge digest; PASS if candidate > parent);
  // openmythos-eval-service.ts (oracle anchors or an LLM judge)
  { component: 'skill_artifacts', class: 'skill', name: 'Skill artifact evolution', unit: 'one SKILL.md instruction candidate vs its parent', flags: ['SKILL_ARTIFACT_EVOLUTION_MODE'],
    outcome: { metric: 'OpenMythos mean score on a pinned case set (oracle anchors; other cases LLM-judged)', source: 'openmythos eval runs (skill-artifact-evolution-service.ts)', independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'benchmark', ref: 'OpenMythos pinned case set (≥ 30), paired candidate vs parent' },
    decision_rule: 'PASS when candidate overall score > parent and no oracle regression (bare >, no margin or CI)', inheritance: 'capability promotion activates the artifact; every skill loader reloads it',
    status: 'closed_loop', note: 'Default off. The selection statistic is weak (bare >) and partly LLM-judge scored.' },
  // asg/ (ASG-001 pre-registered docs/research/asg-001/PREREG.md; executed route always MICRO; 'on' rescues bounded timed-out makers)
  { component: 'skill_granularity', class: 'skill', name: 'Adaptive skill granularity (ASG-001)', unit: 'one oracle-lane maker lease', flags: ['ASG_MODE'],
    outcome: { metric: 'none: expected vs observed effects are recorded, no analysis in the experiment registry', source: "worker_leases.metadata.asg / 'asg_route' events", independence: 'none' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured',
    note: 'No runtime has a macro adapter, so the executed route is always MICRO; on mode refuses to act while the oracle experiments run.' },
  // gym-native-tools.ts (#1189): oracle_gate offered as an MCP tool on ordinary remote gym attempts; gymNativeToolsEvidence is descriptive
  { component: 'gym_native_tools', class: 'skill', name: 'Native skill tool in the gym (oracle_gate)', unit: 'one ordinary remote gym attempt', flags: ['GYM_NATIVE_SKILL_TOOLS'],
    outcome: { metric: 'offered / called / pass rate when called / stopped within N steps of a pass (descriptive)', source: 'gym_result.native_tools (gymNativeToolsEvidence)', independence: 'none' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured',
    note: 'Gym only, never TG/PL/trial/canary/probe/holdout attempts; a contrast needs a pre-registered protocol first.' },
  // ── memory and knowledge ────────────────────────────────────────────────────────────────────────────────────────────────
  // assignment-context.ts (sha256 memory-holdout:<goal> < rate; M5 rule fitness ordering); evolution-evidence.ts memoryHoldoutEvidence;
  // experiment-registry.ts MEMORY_HOLDOUT_CLOSED (EXP-3 FALSIFIED 2026-10-27 → LOOP_MEMORY_RULES_ENABLED=false); memory-template-dedup.ts
  { component: 'memory_rules', class: 'memory', name: 'Memory rules', unit: 'one maker assignment (rules served vs withheld)', experiment: 'memory-holdout', mechanism: 'memory_rules',
    flags: ['LOOP_MEMORY_RULES_ENABLED', 'MEMORY_HOLDOUT_RATE', 'MEMORY_TEMPLATE_DEDUP_MODE'],
    outcome: { metric: `${VERIFIED}, rules vs withheld (non-maker regressions excluded)`, source: "loop_events 'assignment_context' memory_holdout × self_improvements.status (memoryHoldoutEvidence)", independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'randomised', ref: 'memory-holdout' },
    decision_rule: 'EXP-3 registered falsifier: rules arm not above withheld → rules off (fired 2026-10-27); M5 per-rule fitness ordering is inactive while off',
    inheritance: null, status: 'measured_no_selection',
    note: 'Holdout falsified (EXP-3: 66/88 vs withheld 34/42, p 0.40); LOOP_MEMORY_RULES_ENABLED=false since 2026-10-27, so nothing is selected or served. Curator / candidate promotion have no outcome at all.' },
  // ace-001.ts R factor (maker-side top-3 kb_pages, randomised 2×2); kb-corpus.ts kbContext (panel side, KB_CONTEXT_ENABLED, no comparison);
  // knowledge-fitness.ts (read-only, confounded); retrieval-eval.ts with the E1 blind labels (0 eligible labelled queries)
  // web-research.ts (#1197, WEB-001): failure-signature questions → screened web candidates → dream 'knowledge' evidence; a cited mutant genome
  // is judged only by the existing paired gym trial, so the web source itself has no outcome of its own yet
  { component: 'web_research', class: 'knowledge', name: 'Failure-driven web research (WEB-001)', unit: 'one research job (question → screened candidates)', flags: ['WEB_RESEARCH_MODE'],
    outcome: { metric: 'none of its own: genomes citing a web candidate are judged by the paired gym trial (gym_genomes)', source: 'web_research evidence + maker_genomes.evidence_sources_json', independence: 'none' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured',
    note: 'Candidates are unverified web techniques; guardLines, the NE registry and content_safety screen them before any dream prompt.' },
  { component: 'kb_retrieval', class: 'knowledge', name: 'KB retrieval', unit: 'one oracle-lane goal (retrieval on vs off, ACE-001 R)', experiment: 'ACE-001', mechanism: 'kb_retrieval',
    flags: ['KB_CONTEXT_ENABLED', 'ACE_001_MODE'],
    outcome: { metric: `${VERIFIED}, R on − off (withheld until the readout)`, source: "skill_outcomes 'ace-001-arm' (ace001Evidence)", independence: 'independent' },
    cost: { tokens: 'skill_outcomes.tokens_used per arm (known-token runs only)', kwh: null, operator_minutes: 'E1 blind retrieval label rows record labelling time (0 eligible labels)' },
    comparison: { kind: 'randomised', ref: 'ACE-001' }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'Only partly measured: ACE-001 R randomises maker-side retrieval; the panel-side KB context that KB_CONTEXT_ENABLED serves has no comparison (knowledge-fitness is observational and panel-selected). The E1 retrieval benchmark has 0 labels.' },
  // ace-001.ts S factor (similar examples) vs K1 recency examples (assignment-context.ts LOOP_SKILL_CARDS_ENABLED)
  { component: 'example_selection', class: 'knowledge', name: 'Example selection', unit: 'one oracle-lane goal (similar vs recent examples, ACE-001 S)', experiment: 'ACE-001', mechanism: 'example_selection',
    flags: ['LOOP_SKILL_CARDS_ENABLED', 'ACE_001_MODE'],
    outcome: { metric: `${VERIFIED}, S on − off (withheld until the readout)`, source: "skill_outcomes 'ace-001-arm' (ace001Evidence)", independence: 'independent' },
    cost: { tokens: 'skill_outcomes.tokens_used per arm (known-token runs only)', kwh: null, operator_minutes: null },
    comparison: { kind: 'randomised', ref: 'ACE-001' }, decision_rule: null, inheritance: null, status: 'measured_no_selection', note: 'Readout is the operator\'s.' },
  // expert-source-units-service.ts (admission on a jev verdict); knowledge-fitness.ts K1 use edges; evolution-evidence.ts knowledge_links
  // ("no proposal path cites knowledge yet"); expert-resolution-benchmark.ts (30 synthetic queries, retrieval only)
  { component: 'expert_units', class: 'expert', name: 'Expert units / claims', unit: 'one expert unit or claim', flags: ['FRONTIER_UNITS_REQUIRE_RELEVANCE'],
    outcome: { metric: 'none: K1 would credit a unit through use edges, but no proposal path cites expert_unit / expert_claim', source: 'none (knowledge_links counts refs only)', independence: 'none' },
    cost: { tokens: "llm_model_calls consumer 'frontier_experts' + judgments tokens of discovery_relevance", kwh: null, operator_minutes: null },
    comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured',
    note: 'Admission is a jev verdict, not an outcome; the resolution benchmark measures retrieval, not value. A route into dream genomes exists only under DREAM_EVIDENCE_SOURCES=knowledge (default off).' },
  // committee-swarm.ts fleetSourceGate (≥ 50 judged, 0 jev 'yes' → stop ingesting the source); expert-source-units-service.ts
  { component: 'discoveries', class: 'discovery', name: 'Fleet discoveries (sources)', unit: 'one discovery source', flags: ['DISCOVERY_RELEVANCE_SOURCES', 'DISCOVERY_RELEVANCE_PAUSED'],
    outcome: { metric: "share of jev discovery_relevance 'yes' per source", source: "judgments 'discovery_relevance'", independence: 'circular' },
    cost: { tokens: JUDGMENT_TOKENS, kwh: null, operator_minutes: null },
    comparison: { kind: 'none', ref: null }, decision_rule: 'fleetSourceGate: a source with ≥ 50 judged discoveries and 0 jev yes stops being ingested', inheritance: null, status: 'circular',
    note: 'An LLM label decides admission and an LLM label scores the source; the only outcome link (verified proposals citing a ref) is empty.' },
  // honest-numbers.ts commonsYield (Commons children verified vs the refinement base rate, Clopper-Pearson); commons-grounding.ts
  { component: 'commons_refinements', class: 'discovery', name: 'Commons refinements', unit: 'one refinement from a valid Commons grounding', flags: ['COMMONS_GROUNDING_APPLY', 'AUTONOMOUS_LURES_ENABLED'],
    outcome: { metric: `${VERIFIED} of Commons children`, source: "self_improvements.status of Commons children (commonsYield)", independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'benchmark', ref: "refinement base rate (self_improvements source 'refinement')" }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: "Verdict 'below system' is reported only." },
  // improvement-requeue.ts / auto-requeue (REQUEUE_AUTO_MODE); learning-ledger.ts requeue NOT_MEASURED
  { component: 'requeue', class: 'lane', name: 'Automatic requeue', unit: 'one retryable failed run', mechanism: 'requeue', flags: ['REQUEUE_AUTO_MODE', 'REQUEUE_AUTO_MAX_PER_TICK'],
    outcome: { metric: 'none: no evidence function estimates the requeue effect', source: 'none', independence: 'none' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured', note: 'Fixed retry rule (once, retryable classes only).' },
  // ── goal-source lanes (scheduler-registry.ts: test_gap_source 6 h, dead_code_lane / finding_fix_lane 12 h, dependency_lane; caps are
  //    static env values — no rule changes a lane's volume from its outcome; value-allocator.ts is shadow and does not allocate lanes) ──
  // test-gap-source-service.ts run() (TEST_GAP_MAX_PER_DAY shared by test-gap / exports / packages); settlement-execution.ts survivalByLane
  // (informative null on test-only lanes: line retention cannot fail) and settlementValueEvidence (fresh-mutant kill share)
  { component: 'lane_test_gap', class: 'lane', name: 'Lane: test-gap (incl. packages, extra repos)', unit: 'one loop PR of the lane',
    flags: ['TEST_GAP_SOURCE_ENABLED', 'TEST_GAP_PACKAGES_ENABLED', 'TEST_GAP_MAX_PER_DAY', 'EXTRA_REPOS_ENABLED',
      // #1181: restores an out-of-scope package.json/lockfile before the unchanged gates (maker-scope-repair.ts)
      'MAKER_SCOPE_REPAIR'],
    outcome: { metric: SETTLED_KILL, source: 'settlementValueEvidence by_lane test-gap', independence: 'independent' },
    cost: { tokens: LANE_TOKENS, kwh: null, operator_minutes: null }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'Survival cannot fail on test-only PRs (informative null). Packages-lane tests are never re-scored (re-run covers packages/server tests only).' },
  // test-gap-source-service.ts discoverExportGaps; loop-auto-merge.ts settlementRevocation (exports only)
  { component: 'lane_exports', class: 'lane', name: 'Lane: exports', unit: 'one loop PR of the lane', flags: ['TEST_GAP_EXPORTS_ENABLED'],
    outcome: { metric: SETTLED_KILL, source: 'settlementValueEvidence by_lane exports', independence: 'independent' },
    cost: { tokens: LANE_TOKENS, kwh: null, operator_minutes: null }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'The only lane whose settled value feeds a rule — the auto_merge settlement revoke (merge eligibility, not lane volume).' },
  // test-gap-source-service.ts mutation-gap (Stryker gain command = the acceptance test); graded-fitness.ts (mutation score = the same check)
  { component: 'lane_mutation_gap', class: 'lane', name: 'Lane: mutation-gap', unit: 'one loop PR of the lane', flags: ['MUTATION_GAP_ENABLED', 'MUTATION_GAP_MAX_PER_DAY'],
    outcome: { metric: SETTLED_KILL, source: 'settlementValueEvidence by_lane mutation', independence: 'independent' },
    cost: { tokens: LANE_TOKENS, kwh: null, operator_minutes: null }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'measured_no_selection',
    note: 'The maker-time score is circular (the Stryker check the maker aimed at); only the settlement re-score is independent.' },
  // no such lane: TEST_GAP_PACKAGES_ENABLED covers shared / agent-catalog / mcp-server; dashboard files are ORACLE_TEST_FILES auto-merge refuses
  { component: 'lane_dashboard', class: 'lane', name: 'Lane: dashboard', unit: 'one dashboard test-gap proposal (TEST_GAP_DASHBOARD_ENABLED, #1182)', flags: ['TEST_GAP_DASHBOARD_ENABLED'],
    outcome: { metric: 'none', source: 'none', independence: 'none' }, cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured',
    note: 'Goal source since #1182 (discoverDashboardGaps in test-gap-source-service.ts); its PRs map to the test-gap lane, no own settled-outcome readout yet.' },
  // finding-fix-source.ts (scripts/finding-fix-gate.mjs is both the finding source and the oracle; refs map to lane 'other')
  { component: 'lane_finding_fix', class: 'lane', name: 'Lane: finding-fix', unit: 'one loop PR of the lane', flags: ['FINDING_FIX_LANE', 'FINDING_FIX_MAX_PER_DAY'],
    outcome: { metric: 'the finding is gone per finding-fix-gate.mjs — the same script that produced it', source: 'loop run checks (finding-fix-gate.mjs)', independence: 'circular' },
    cost: { tokens: LANE_TOKENS, kwh: null, operator_minutes: null }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'circular',
    note: "Pooled into lane 'other' in survival and settlement; production-code PRs mostly settle as no_test_files." },
  // dead-code-source-service.ts (test:dead-code:grounded is a verification gate, not a value metric; lane 'other')
  { component: 'lane_dead_code', class: 'lane', name: 'Lane: dead-code', unit: 'one loop PR of the lane', flags: ['DEAD_CODE_LANE_ENABLED', 'DEAD_CODE_MAX_PER_DAY'],
    outcome: { metric: 'none', source: "none (pooled into lane 'other')", independence: 'none' }, cost: { tokens: LANE_TOKENS, kwh: null, operator_minutes: null },
    comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured', note: 'Static cap; the panel stays in the path.' },
  // dependency-lane.ts (main CI on the merge sha → dependency_lane_prs.main_state; red → revoked_at, back to shadow); runs store
  // dependency_pr_url, not pr_url, so they never enter survival / settlement
  { component: 'lane_dependency', class: 'lane', name: 'Lane: dependency', unit: 'one dependency bump PR', flags: ['DEPENDENCY_LANE_MODE', 'DEPENDENCY_LANE_MAX_PER_DAY'],
    outcome: { metric: 'main CI on the merge sha (red / green)', source: 'dependency_lane_prs.main_state', independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: 'a red main CI revokes the lane to shadow until the operator re-enables it (failure tripwire)',
    inheritance: null, status: 'measured_no_selection', note: 'A safety signal, not a value signal; absent from survival and settlement (no pr_url).' },
  // advisory-exposure.ts (EVE-V advisories → OSV → lockfile verdicts; oracle-checked bump proposals)
  { component: 'lane_advisory', class: 'lane', name: 'Lane: advisory exposure', unit: 'one advisory bump proposal', flags: ['ADVISORY_EXPOSURE_MODE'],
    outcome: { metric: 'none', source: 'none', independence: 'none' }, cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured',
    note: 'Deterministic exposure verdicts; no outcome scores the lane.' },
  // content-drafts.ts (one signal per 24 h; verifier checks; draft PRs)
  { component: 'lane_content_drafts', class: 'lane', name: 'Lane: content drafts', unit: 'one blog draft PR', flags: ['CONTENT_DRAFTS_MODE'],
    outcome: { metric: 'none: verifier pass rate per check is the draft\'s own gate', source: 'none', independence: 'none' }, cost: { tokens: "judgments 'content_draft' tokens", kwh: null, operator_minutes: null },
    comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured', note: 'Human-merged drafts; no value outcome.' },
  // capability-factory.ts (operator request → reuse or one grounded proposal → merged capability; lifecycle v2 candidate on draft PR)
  { component: 'lane_capability_factory', class: 'lane', name: 'Lane: capability factory', unit: 'one operator capability request',
    flags: ['CAPABILITY_FACTORY_MODE', 'CAPABILITY_FACTORY_REUSE_EXECUTE', 'CAPABILITY_LIFECYCLE_V2'],
    outcome: { metric: 'none: request status only (reused / merged / registered)', source: "judgments capability_factory requests", independence: 'none' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, status: 'unmeasured', note: 'The operator chooses what is built.' },
  // ── merge ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // loop-auto-merge.ts eligibility; loop-auto-merge-state.ts (no earn rule in code: missing row = active); checkRevocations (revert, survival
  // SETTLED_REGRESSED — cannot fire on test-only PRs — or main CI red twice); settlementRevocation (exports: ≥ 50 % of the last 20 settled
  // below 0.2 → lane revoked); isAuditSample (10 % by sha256 of the PR number, left to the human — no contrast computed; AUDIT_SAMPLE_AUTO_MODE=act judges it by an executed audit and keeps fail / unknown + a 1-in-5 spot check)
  { component: 'auto_merge', class: 'merge', name: 'Test-only auto-merge', unit: 'one eligible loop PR',
    flags: ['LOOP_AUTO_MERGE_TEST_ONLY', 'AUDIT_SAMPLE_AUTO_MODE', 'LOOP_AUTO_MERGE_FINDING_FIX', 'LOOP_AUTO_MERGE_MAX_PER_DAY', 'LOOP_AUTO_MERGE_RECHECK', 'LOOP_AUTO_MERGE_RECHECK_HOURS', 'LOOP_AUTO_MERGE_SETTLEMENT_REVOKE', 'LOOP_AUTO_MERGE_REPOS', 'WEAK_ASSERTION_CHECK_MODE', 'SETTLEMENT_EXECUTION_MODE'],
    outcome: { metric: `${SETTLED_KILL}; reverts and main CI on the merge commit`, source: 'latestSettlements + checkRevocations (loop-auto-merge.ts)', independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null },
    decision_rule: 'revoke only: a revert, SETTLED_REGRESSED or main CI red twice revokes the class; exports lane revoked when ≥ 50 % of its last 20 settled PRs kill < 0.2 of fresh mutants',
    inheritance: null, status: 'measured_no_selection',
    note: 'Failure tripwires on fixed thresholds; a good result never widens lanes or raises the cap. The 10 % audit sample is a latent holdout — no auto-merged vs audit contrast is computed. The class was earned by an operator decision, not a rule.' },
  // loop-auto-merge-state.ts autoMergeValueSignal (FBPA pass, or graded mutant_kill / mutation_score ≥ 0.2); auto-merge-value-replay.ts replays the
  // same maker-time signal; graded-fitness.ts (3 seeded mutants by default, 6 under GRADED_FITNESS_MUTANTS_V2)
  { component: 'value_gate', class: 'merge', name: 'Auto-merge value gate', unit: 'one auto-merge candidate PR', flags: ['LOOP_AUTO_MERGE_VALUE_GATE', 'LOOP_AUTO_MERGE_VALUE_GATE_LANES', 'GRADED_FITNESS_MUTANTS_V2', 'GRADED_FITNESS_MODE'],
    outcome: { metric: `${SETTLED_KILL} of PRs the gate passed`, source: 'settlementValueEvidence (settlement-execution.ts)', independence: 'independent' },
    cost: { ...NO_COST }, comparison: { kind: 'none', ref: null },
    decision_rule: 'pass when FBPA passes against the parent source or the maker-time graded mutant kill / mutation score ≥ 0.2; otherwise ineligible',
    inheritance: null, status: 'measured_no_selection',
    note: 'The threshold is fixed and nothing tunes it on settlement. Its input is maker-time: optimistic for exports (code notes 12/20 passed PRs < 0.2 at settlement) and circular for mutation-gap (the maker\'s own acceptance check). The replay re-scores the same signal, not a counterfactual.' },
];

/** Acting flags that steer no learning component: infrastructure, safety, plumbing or approval routing. A reason is required. */
export const FITNESS_EXEMPT_FLAGS: Readonly<Record<string, string>> = {
  SKILL_FIRST_MODE: 'dispatch of explicit executable-skill requests; existing approval and promotion gates decide',
  DJIMITSEC_SCAN_MODE: 'fixed repository security scan dispatch (pinned worker), not a scored component',
  DJIMITSEC_SCAN_TRIGGERS: 'webhook triggers for the fixed security scan, not a scored component',
  RUNTIME_PROCESS_GROUP_KILL: 'runtime process termination (infrastructure)',
  LOOP_EVIDENCE_FRESHNESS_MODE: 'pipeline correctness: a PR whose read set changed on main is re-checked',
  LOOP_RESUME_INTERRUPTED: 'pipeline recovery: one fresh maker for a run interrupted by a restart',
  LOOP_AUTO_DRAFT_PR_ENABLED: 'pipeline: a certified run is opened as a draft PR',
  LOOP_DRAFT_PR_RETRY: 'pipeline recovery: re-opens draft PRs that failed to open',
  WORK_ITEM_OUTCOME_SYNC: 'bookkeeping: a settled goal closes its source work item',
  LOOP_AUTO_APPROVE_TEST_GAP: 'approval routing for the test-gap lane (who approves), not a scored component',
  LOOP_AUTO_APPROVE_MUTATION_GAP: 'approval routing for the mutation-gap lane (who approves), not a scored component',
  ORACLE_LANES_AUTO_APPROVE: 'approval routing for the oracle lanes (who approves), not a scored component',
  APPROVAL_INHERIT_ENABLED: 'approval plumbing: a re-run inherits the original approval within a TTL',
  LOOP_REVIEWER_APPROVAL_INHERIT: 'approval plumbing: reviewers inherit the run\'s one human approval',
  PROPOSAL_GROUNDING_REQUIRED: 'intake rule: ungrounded reflection proposals are parked before the panel',
  SELF_IMPROVEMENT_GOAL_ON_APPROVE: 'scheduling: create the goal at panel approval instead of the hourly cycle',
  GOVERNANCE_GATE_ENABLED: 'safety gate: tightens allow to require_approval from a governance score; never selects a learner',
  OLLAMA_OUTAGE_FALLBACK_RUNTIME: 'inference failover runtime (infrastructure); fallback runs are excluded from the experiments',
  OLLAMA_AUTO_FAILOVER: 'inference failover (infrastructure)',
  OLLAMA_FAILOVER_PROBE_MODEL: 'inference failover probe (infrastructure)',
  PANEL_FALLBACK_RUNTIME: 'panel inference fallback (infrastructure); fallback reviews are excluded from panel calibration',
  PANEL_FALLBACK_MODEL: 'panel inference fallback model (infrastructure)',
  INFERENCE_BUDGET_THROTTLE: 'inference budget throttle (cost guard, infrastructure)',
  OLLAMA_WEEKLY_TOKEN_BUDGET: 'inference budget size (cost guard, infrastructure)',
  OLLAMA_THROTTLE_AT: 'inference budget threshold (cost guard, infrastructure)',
  OPENCODE_BRAKE_CACHE_READ_WEIGHT: 'token brake accounting for opencode makers (cost guard); a treatment variable of the oracle experiments',
  MAKER_UID_SEPARATION: 'sandbox isolation of maker processes (security)',
  FLEET_EVENT_SIGNATURES: 'signature verification of fleet events (security)',
  FLEET_SHELL_ENABLED: 'kill switch for fleet shell commands (security)',
  MEMORY_DELIVERY_RECEIPTS: 'delivery receipts for the memory-sync fan-out (plumbing)',
};

/** Registry rules. A violation is a contract that claims more learning than its fields support. */
export function contractViolations(contracts: readonly FitnessContract[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of contracts) {
    const v = (m: string) => out.push(`${c.component}: ${m}`);
    if (seen.has(c.component)) { v('duplicate component'); continue; }
    seen.add(c.component);
    const ind = c.outcome.independence;
    if (c.comparison.kind !== 'none' && !(c.comparison.ref ?? '').trim()) v(`comparison ${c.comparison.kind} names no experiment or benchmark`);
    if (c.status === 'closed_loop') {
      if (c.comparison.kind === 'none') v('closed_loop needs a comparison (randomised / holdout / benchmark), not none');
      if (!(c.decision_rule ?? '').trim()) v('closed_loop needs a decision_rule');
      if (ind !== 'independent') v(`closed_loop needs an outcome independent of the component (got ${ind})`);
      continue;
    }
    if (ind === 'circular' && c.status !== 'circular') v(`a circular outcome has status circular (got ${c.status})`);
    else if (ind === 'none' && c.status !== 'unmeasured') v(`an outcome of none is unmeasured (got ${c.status})`);
    else if (c.status === 'unmeasured' && ind !== 'none') v(`unmeasured has no outcome (independence none), got ${ind}`);
    else if (c.status === 'circular' && ind !== 'circular') v(`circular needs a circular outcome, got ${ind}`);
  }
  return out;
}

/** Acting flags that neither a contract nor a reasoned exemption covers (a new acting flag lands here until it gets one). */
export function uncoveredActingFlags(flags: ReadonlyArray<{ name: string; acting: boolean }>, contracts: readonly FitnessContract[] = FITNESS_CONTRACTS,
  exempt: Readonly<Record<string, string>> = FITNESS_EXEMPT_FLAGS): string[] {
  const mapped = new Set(contracts.flatMap((c) => c.flags));
  return flags.filter((f) => f.acting && !mapped.has(f.name) && !((exempt[f.name] ?? '').trim().length >= 20)).map((f) => f.name);
}

/**
 * The evolution-evidence section: counts by status, acting-flag coverage, registry violations and the list. Static apart from
 * the learning ledger's status per mechanism, passed in (no new statistic). `flags` is EVOLUTION_FLAGS, passed in by the caller.
 */
export function fitnessContractsReport(flags: ReadonlyArray<{ name: string; acting: boolean }>,
  ledger: { mechanisms: Array<{ mechanism: string; status: LearningStatus }> } | null = null, contracts: readonly FitnessContract[] = FITNESS_CONTRACTS,
  exempt: Readonly<Record<string, string>> = FITNESS_EXEMPT_FLAGS) {
  const actingNames = flags.filter((f) => f.acting).map((f) => f.name);
  const mappedNames = new Set(contracts.flatMap((c) => c.flags));
  const unmapped = uncoveredActingFlags(flags, contracts, exempt);
  const by_status = Object.fromEntries(FITNESS_STATUSES.map((s) => [s, contracts.filter((c) => c.status === s).length])) as Record<FitnessStatus, number>;
  return {
    total: contracts.length, by_status,
    coverage: { acting_flags: actingNames.length, mapped: actingNames.filter((n) => mappedNames.has(n)).length,
      exempt: actingNames.filter((n) => !mappedNames.has(n) && !unmapped.includes(n)).length, unmapped },
    violations: contractViolations(contracts),
    contracts: contracts.map((c) => ({ ...c, ledger_status: c.mechanism ? ledger?.mechanisms.find((m) => m.mechanism === c.mechanism)?.status ?? null : null })),
    note: 'Static, read-only registry (services/fitness-contracts.ts). closed_loop = an independent executed outcome, a fair comparison (randomised / holdout / benchmark) and a decision rule that acts on it. ledger_status is the learning ledger\'s reading for the same mechanism.',
  };
}
