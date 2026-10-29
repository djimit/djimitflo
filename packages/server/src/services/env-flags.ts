import { EVOLUTION_FLAGS } from './evolution-evidence';

/**
 * M2c (E-A28, A-C8): env flag hygiene.
 * FLAG_NAME_PATTERN marks env names that switch or cap behaviour. Every such name the server reads is either in
 * EVOLUTION_FLAGS (evolution-evidence.ts: shown on the evidence page) or in NON_EVOLUTION_FLAGS below (runtime, scheduler,
 * cap … with a one-word reason); runbook-flags-drift.test.ts fails on a new name in neither list. So a flag-shaped name that is
 * set but in neither list is read by nothing in this build (a typo, a retired flag, a flag of another process): boot logs it.
 */
export const FLAG_NAME_PATTERN = /_MODE(?:_|$)|_ENABLED(?:_|$)|REQUIRE_|_AUTO_|_INHERIT|_SKIP_|_MAX_PER_DAY$|_SHARE$/;

/** Read by judgmentMode (judgment-service.ts) as TYPESAFE_<judgment id>_MODE, so no literal read exists. */
const DYNAMIC_FLAGS = [/^TYPESAFE_[A-Z0-9_]+_MODE$/];

/** Flag-shaped env names the server reads that do not steer the evolution loop. */
export const NON_EVOLUTION_FLAGS: Readonly<Record<string, string>> = {
  APPROVAL_INHERIT_TTL_MS: 'parameter',
  ARENA_FORECASTS_ENABLED: 'shadow',
  AUTONOMY_SHADOW_ENABLED: 'shadow',
  BUILD_ERROR_PROPOSALS_ENABLED: 'source',
  CLAUDE_SKIP_PERMISSIONS: 'runtime',
  CLINE_SKIP_PERMISSIONS: 'runtime',
  CODEX_SKIP_PERMISSIONS: 'runtime',
  COMMITTEE_MAX_PER_DAY: 'cap',
  COMMONS_EVIDENCE_PACK_ENABLED: 'commons',
  COMMONS_FALSIFIER_MAX_PER_DAY: 'cap',
  COMMONS_PROPOSAL_REVIEW_ENABLED: 'commons',
  COMPLIANCE_REPORT_SCHEDULER_ENABLED: 'scheduler',
  CONTENT_SAFETY_MODE: 'safety',
  COST_CASCADE_ENABLED: 'routing',
  DASHBOARD_SERVE_ENABLED: 'infra',
  DISCOVERY_GATE_SHADOW_MAX_PER_DAY: 'cap',
  DISCOVERY_REJUDGE_MAX_PER_DAY: 'cap',
  DISK_GUARD_ENABLED: 'infra',
  DJIMITFLO_DATA_MODE: 'provenance',
  DJIMITFLO_FEDERATION_ENABLED: 'federation',
  DJIMITFLO_FRONTIER_EXPERTS_ENABLED: 'knowledge',
  DJIMIT_DEEP_ENABLED: 'runtime',
  DOCKER_NETWORK_MODE: 'sandbox',
  DOCKER_SANDBOX_SKIP_DIGEST_CHECK: 'sandbox',
  DREAM_CYCLE_LEGACY_ENABLED: 'legacy',
  DREAM_STATE_ENABLED: 'scheduler',
  DREAM_STATE_PROPOSALS_ENABLED: 'source',
  EVENT_PUBLISH_ENABLED: 'bus',
  EVOLUTION_GYM_ENABLED: 'gym',
  EVOLUTION_GYM_MAX_PER_DAY: 'gym',
  EVOLUTION_GYM_REMOTE_ENABLED: 'gym',
  FEEDBACK_INTERESTS_ENABLED: 'knowledge',
  FRONTIER_EXPERTS_SCHEDULER_ENABLED: 'knowledge',
  FRONTIER_EXPERT_PERSONS_ENABLED: 'knowledge',
  FRONTIER_EXPERT_SOURCE_UNITS_ENABLED: 'knowledge',
  FRONTIER_TECHNIQUE_CARDS_ENABLED: 'knowledge',
  GEMINI_SKIP_PERMISSIONS: 'runtime',
  GOAL_DECOMPOSER_AUTO_MISSIONS: 'observe-only',
  GOVERNANCE_GATE_ENABLED: 'governance',
  GOVERNANCE_GUARD_MODE: 'governance',
  KNOWLEDGE_MAINTENANCE_ENABLED: 'knowledge',
  LLM_JSON_REPAIR_ENABLED: 'parsing',
  LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED: 'checker',
  LOOP_DRAFT_PR_THROTTLE_MODE: 'throttle',
  LOOP_REVIEWER_RETRY_ENABLED: 'retry',
  MAKER_DEPS_001_MODE: 'experiment',
  MEMORY_CANDIDATE_REVIEW_ENABLED: 'scheduler',
  MUTATION_GAP_ENABLED: 'source',
  MUTATION_GAP_MAX_PER_DAY: 'cap',
  NEEDS_GROUNDING_TRIAGE_ENABLED: 'triage',
  OPENCODE_SKIP_PERMISSIONS: 'runtime',
  OPENMYTHOS_DISCRIMINATION_GATE_ENABLED: 'benchmark',
  OPENMYTHOS_NIGHTLY_ENABLED: 'benchmark',
  OPERATOR_DIGEST_ENABLED: 'operator',
  PANEL_WEIGHTED_SHADOW_ENABLED: 'shadow',
  PROOF_RUN_SKIP_PERMISSIONS: 'runtime',
  PROPOSAL_DEDUPE_MODE: 'dedupe',
  QUEUE_HYGIENE_ENABLED: 'hygiene',
  RANSOMWARE_MODULE_ENABLED: 'security',
  RANSOMWARE_MODULE_MODE: 'security',
  RECONCILIATION_NIGHTLY_ENABLED: 'scheduler',
  REFLECTION_PROPOSALS_MAX_PER_DAY: 'cap',
  REMOTE_MAKER_ENABLED: 'fleet',
  RETENTION_ENABLED: 'scheduler',
  RUNTIME_ADMISSION_MODE: 'admission',
  RUNTIME_ALLOW_SKIP_PERMISSIONS: 'runtime',
  SCHEDULER_SELF_HEAL_MODE: 'scheduler',
  SEGML_AUTO_APPROVE_CASES: 'segml',
  SEGML_ENABLED: 'segml',
  SEGML_ROLLBACK_ENABLED: 'segml',
  SEGML_VALIDATION_ENABLED: 'segml',
  SELF_HEALING_SCHEDULER_ENABLED: 'scheduler',
  SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED: 'scheduler',
  SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES: 'scheduler',
  SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED: 'gate',
  SELF_IMPROVEMENT_REFINEMENT_ENABLED: 'source',
  SPECIALIST_PANEL_BACKLOG_ENABLED: 'scheduler',
  STALL_WATCH_ENABLED: 'monitor',
  TELEGRAM_PUSH_ENABLED: 'operator',
  TELEGRAM_TRIAGE_ENABLED: 'operator',
  TEST_GAP_EXPORTS_ENABLED: 'source',
  TEST_GAP_MAX_PER_DAY: 'cap',
  TEST_GAP_PACKAGES_ENABLED: 'source',
  TEST_GAP_SOURCE_ENABLED: 'source',
  TRAJECTORY_BRIDGE_ENABLED: 'telemetry',
  TYPESAFE_LOCAL_SHADOW_ENABLED: 'shadow',
};

export function unknownEnvFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const known = new Set([...EVOLUTION_FLAGS.map((f) => f.name), ...Object.keys(NON_EVOLUTION_FLAGS)]);
  return Object.keys(env)
    .filter((n) => env[n] !== undefined && FLAG_NAME_PATTERN.test(n) && !known.has(n) && !DYNAMIC_FLAGS.some((re) => re.test(n)))
    .sort();
}

/** Boot: one line naming every set flag nobody reads (names only, never values). */
export function warnUnknownEnvFlags(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = console.warn): void {
  const unknown = unknownEnvFlags(env);
  if (unknown.length) warn(`⚠️  ${unknown.length} env flag(s) set but not read by this build: ${unknown.join(', ')}`);
}
