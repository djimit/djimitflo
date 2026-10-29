import { EVOLUTION_FLAGS } from './evolution-evidence';

/**
 * M2c (E-A28, A-C8): env flag hygiene.
 * FLAG_NAME_PATTERN marks env names that switch or cap behaviour. Every such name the server reads is either in
 * EVOLUTION_FLAGS (evolution-evidence.ts: shown on the evidence page) or in NON_EVOLUTION_FLAGS below (runtime, scheduler,
 * cap … with a one-word reason); runbook-flags-drift.test.ts fails on a new name in neither list. So a flag-shaped (or
 * runtime/model selector) name that is set but read by no code path in this build — a typo, a retired flag, a flag of
 * another process — is named in one boot warning.
 */
export const FLAG_NAME_PATTERN = /_MODE(?:_|$)|_ENABLED(?:_|$)|REQUIRE_|_AUTO_|_INHERIT|_SKIP_|_MAX_PER_DAY$|_SHARE$/;

/**
 * Review #1094: runtime / model selectors (`LOOP_CHECKER_RUNTIME=hermes` was set in prod and read by nothing). A name of this
 * shape is "read" only if a code path reads it: READ_SELECTOR_ENV (literal reads + the child-runtime env allowlists; kept equal
 * to the source by runbook-flags-drift.test.ts), a dynamic read below, or a name the operator passes through to children.
 */
export const SELECTOR_NAME_PATTERN = /_RUNTIME$|_MODEL$|_PROVIDER$|_TIMEOUT_MS$|_SPECIES$|^MODEL_CANDIDATES_/;

export const READ_SELECTOR_ENV: readonly string[] = [
  'ATOMIC_AGENT_MODEL', 'ATOMIC_EXECUTION_TIMEOUT_MS', 'CHECKER_CROSS_MODEL', 'CLAUDE_EXECUTION_TIMEOUT_MS',
  'CLINE_EXECUTION_TIMEOUT_MS', 'CODEX_EXECUTION_TIMEOUT_MS', 'COMMONS_PROPOSAL_REVIEW_TIMEOUT_MS',
  'CONTENT_SAFETY_MODEL', 'DENNIS_AGENT_MODEL', 'DJIMITFLO_ASK_LLM_MODEL', 'DJIMITFLO_ASK_TIMEOUT_MS',
  'DJIMITFLO_AUTHOR_LLM_MODEL', 'DJIMITFLO_CLAUDE_MODEL', 'DJIMITFLO_CLINE_MODEL', 'DJIMITFLO_CODEX_MODEL',
  'DJIMITFLO_EMBED_MODEL', 'DJIMITFLO_GEMINI_MODEL', 'DJIMITFLO_OPENCODE_MODEL', 'DJIMITFLO_QDRANT_SEARCH_TIMEOUT_MS',
  'DJIMIT_SKILL_TRAINING_GATE_TIMEOUT_MS', 'DOCKER_TIMEOUT_MS', 'DREAM_EVOLUTION_MODEL', 'DREAM_EVOLUTION_SPECIES',
  'EMBEDDING_MODEL', 'EMBEDDING_PROVIDER', 'EMBEDDING_TIMEOUT_MS', 'EVOLUTION_GYM_EXTRA_SPECIES',
  'EXECUTION_EVENT_STREAM_TIMEOUT_MS', 'FRONTIER_EXPERTS_RUNTIME', 'GEMINI_EXECUTION_TIMEOUT_MS',
  'GITHUB_PR_REVIEW_RUNTIME', 'GYM_MAKER_TIMEOUT_MS', 'HERMES_EXECUTION_TIMEOUT_MS', 'JEV_CHALLENGER_MODEL',
  'LOOP_BANDIT_SPECIES', 'LOOP_DAEMON_CHECK_TIMEOUT_MS', 'LOOP_DAEMON_MAKER_RUNTIME', 'LOOP_EVOLVE_SPECIES',
  'LOOP_MAKER_TIMEOUT_MS', 'LOOP_REVIEWER_TIMEOUT_MS', 'LOOP_RUNTIME_PROBE_TIMEOUT_MS', 'OLLAMA_EMBED_MODEL',
  'OLLAMA_FAILOVER_PROBE_MODEL', 'OLLAMA_FALLBACK_MODEL', 'OLLAMA_OUTAGE_FALLBACK_RUNTIME',
  'OPENCODE_EXECUTION_TIMEOUT_MS', 'OPENMYTHOS_AGENT_MODEL', 'OPENMYTHOS_JUDGE_MODEL', 'OPENMYTHOS_WORKER_TIMEOUT_MS',
  'PANEL_FALLBACK_MODEL', 'PANEL_FALLBACK_RUNTIME', 'PI_EXECUTION_TIMEOUT_MS', 'PI_MODEL', 'PI_PROVIDER',
  'PROOF_RUN_RUNTIME_TIMEOUT_MS', 'REMOTE_MAKER_QUEUE_TIMEOUT_MS', 'REMOTE_MAKER_TIMEOUT_MS',
  'SELF_IMPROVEMENT_REFINEMENT_MODEL', 'SELF_IMPROVEMENT_REFINEMENT_TIMEOUT_MS', 'SELF_IMPROVEMENT_REVIEW_MODEL',
  'SELF_IMPROVEMENT_REVIEW_TIMEOUT_MS', 'SOCIAL_AUTOPILOT_FALLBACK_MODEL', 'SOCIAL_AUTOPILOT_FALLBACK_RUNTIME',
  'SOCIAL_AUTOPILOT_MODEL', 'SOCIAL_AUTOPILOT_RUNTIME', 'SSE_STALL_TIMEOUT_MS', 'SUBSCRIPTION_GYM_SPECIES',
  'TYPESAFE_MODEL'
];

/** Lease runtimes (worker_leases.runtime): leaseIdentity reads DJIMITFLO_<RUNTIME>_MODEL for each. */
const LEASE_RUNTIMES = ['manual', 'mock', 'codex', 'opencode', 'claude', 'gemini', 'editor', 'pi', 'atomic', 'remote'];

/** Names built at run time, so no literal read exists. */
const DYNAMIC_FLAGS = [
  /^TYPESAFE_[A-Z0-9_]+_MODE$/, // judgmentMode (judgment-service.ts): TYPESAFE_<judgment id>_MODE
  /^[A-Z0-9]+_SOCIAL_MODEL$/, // scripts/commons-runtime-proof.ts: <RUNTIME>_SOCIAL_MODEL
  new RegExp(`^DJIMITFLO_(${LEASE_RUNTIMES.join('|').toUpperCase()})_MODEL$`), // reviewer-independence leaseIdentity
  /^MODEL_CANDIDATES_PANEL_REVIEW$/, // model-selector candidates('panel_review'), the only consumer
];

/** llm-fallback reads LLM_FALLBACK<n>_MODEL only for a configured LLM_FALLBACK<n>_OPENAI_URL (n = '' | 2). */
function conditionallyRead(name: string, env: NodeJS.ProcessEnv): boolean {
  const m = name.match(/^LLM_FALLBACK(2?)_MODEL$/);
  return Boolean(m && env[`LLM_FALLBACK${m[1]}_OPENAI_URL`]?.trim());
}

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
  const passthrough = (env.RUNTIME_ENV_PASSTHROUGH || '').split(',').map((v) => v.trim()).filter(Boolean); // copied to every child
  const known = new Set([...EVOLUTION_FLAGS.map((f) => f.name), ...Object.keys(NON_EVOLUTION_FLAGS), ...READ_SELECTOR_ENV, ...passthrough]);
  return Object.keys(env)
    .filter((n) => env[n] !== undefined && (FLAG_NAME_PATTERN.test(n) || SELECTOR_NAME_PATTERN.test(n)) && !known.has(n)
      && !DYNAMIC_FLAGS.some((re) => re.test(n)) && !conditionallyRead(n, env))
    .sort();
}

/** Boot: one line naming every set flag nobody reads (names only, never values). */
export function warnUnknownEnvFlags(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = console.warn): void {
  const unknown = unknownEnvFlags(env);
  if (unknown.length) warn(`⚠️  ${unknown.length} env flag(s) set but not read by this build: ${unknown.join(', ')}`);
}
