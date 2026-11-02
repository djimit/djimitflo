import type { PageFixture } from './route-fixtures';
import type {
  AgentInteractionRecord,
  ExpertSummary,
  KnowledgeOverview,
  SkillCardsView,
  SocialCommons,
} from '../lib/api';

const AT = '2026-10-01T12:00:00Z';

const INTERACTION: AgentInteractionRecord = {
  id: 'ix-fixture-1', timestamp: AT, correlation_id: 'corr-fixture-1', causation_id: null,
  actor: { type: 'agent', id: 'fixture-alpha-agent', role: 'maker', runtime: null, model: null },
  action: 'review.requested', target: { type: 'agent', id: 'fixture-beta-agent' }, capability_id: null, decision: null,
  status: 'recorded', evidence_refs: [], effect_scope: 'simulated', source: 'fixture', summary: 'Fixture interaction summary',
};

const COMMONS: SocialCommons = {
  agents: [{
    id: 'agent-fixture-1', name: 'fixture-commons-agent', status: 'idle', capabilities: ['review'], model: 'model-a',
    runtime: null, last_heartbeat_at: null, present: false, activity: [],
  }],
  threads: [],
};

/** Partial EvolutionEvidence (shape of EMPTY in EvolutionPage.test.tsx); the page renders the sections it gets. */
const EVOLUTION = {
  at: AT, window_days: 30, flags: [], outcomes: [], outcomes_tagged: [],
  merge: { settled: [], merge_outcomes: 0, first_settled: null, settlement: null },
  drafts: { unsettled: 0, unsettled_open_or_recent: 0, anomalous: null, age_days_p50: null, age_days_max: null, note: '' },
  genomes: { by_status: [], recent: [], holdout: { mined: null, mutant: null } },
  gym: [], trials: { by_state: [], recent: [] },
  models: { mode: 'off', rows: [], would_pick: {} },
  oracle: { n: 0, kappa: null, kappa_ci: null, agreement: { all: null, conf_ge_06: null, conf_lt_06: null }, accuracy: { n: 0, jev: null, checker: null }, kappa_jev_outcome: null, kappa_jev_outcome_ci: null, kappa_checker_outcome: null, enforce_eligible: false, note: '' },
  commons: { k: 0, n: 0, rate: null, ci: [0, 1], base_rate: null, base_ci: [0, 1], base_n: 0, verdict: 'unmeasured', note: '' },
  forecasts_v2: { scored: 0, decision_grade: 0, decision_grade_skilled: 0, insufficient: 0 },
  gates: {
    A: { state: 'unknown', reason: 'fixture-gate-alpha reason' },
    B: { state: 'red', reason: 'fixture gate B' },
    C: { state: 'red', reason: 'fixture gate C' },
    D: { state: 'green', reason: 'fixture gate D' },
  },
};

const KNOWLEDGE: KnowledgeOverview = {
  at: AT,
  sources: [{ source: 'fixture-source-alpha', events: 12, events_7d: 3, last: AT, yes: 4, uncertain: 2, no: 6, units: 5, relevant_pct: 33 }],
  relevance: { yes: 4, uncertain: 2, no: 6 },
  recent_relevant: [],
  kb_retrieval: { hits_30d: 0, panels_30d: 0, last: null },
  interest_profile: null,
};

const SKILLS: SkillCardsView = { mode: 'off', total: null, by_lane: [], latest: [], reason: null, note: 'fixture' };

const EXPERT: ExpertSummary = {
  id: 'expert-fixture-1', canonical_name: 'Fixture Area Alpha', lifecycle_state: 'CHECKED', identity_confidence: 0.9,
  version: 1, updated_at: AT, capabilities: ['fixture-capability'], provenance_json: '{}', kind: 'area',
};

const COGNITIVE_STATS = { totalEpisodes: 4217, totalPatterns: 12, totalStrategies: 3, overallSuccessRate: 0.75, bestGoalType: null };

export const FIXTURES: Record<string, PageFixture> = {
  '/interaction-board': {
    primary: 'GET /api/swarms/intelligence/interactions',
    responses: { 'GET /api/swarms/intelligence/interactions': { interactions: [INTERACTION] } },
    shows: 'fixture-alpha-agent',
  },
  '/agent-commons': {
    primary: 'GET /api/swarm-v2/social/commons',
    responses: { 'GET /api/swarm-v2/social/commons': COMMONS },
    shows: 'fixture-commons-agent',
  },
  '/evolution': {
    primary: 'GET /api/health/evolution-evidence',
    responses: { 'GET /api/health/evolution-evidence': EVOLUTION },
    shows: 'fixture-gate-alpha reason',
  },
  '/knowledge': {
    primary: 'GET /api/health/knowledge',
    responses: { 'GET /api/health/knowledge': KNOWLEDGE, 'GET /api/health/skills': SKILLS },
    shows: 'fixture-source-alpha',
  },
  '/frontier-experts': {
    primary: 'GET /api/swarms/expert/experts',
    responses: { 'GET /api/swarms/expert/experts': { experts: [EXPERT] }, 'GET /api/swarms/expert/history': [] },
    shows: 'Fixture Area Alpha',
  },
  '/economy': {
    primary: 'GET /api/swarms/economy',
    responses: {
      'GET /api/swarms/economy': {
        capabilities: [{
          capability_id: 'fixcap-econ1', capability_kind: 'skill', status: 'validated', n_runs: 7, n_completed: 6, success_rate: 0.86,
          p50_tokens: 1000, p95_tokens: 2000, p50_dollars: 0.0123, p95_dollars: 0.0456, verified_artifacts_per_dollar: 12.5,
        }],
        recent_runs: [],
        summary: { total_capabilities: 1, total_verified_artifacts: 4217, total_completed_unverified: 2, total_dollars_spent: 1.5 },
      },
    },
    shows: 'fixcap-econ1',
  },
  '/federation': {
    primary: 'GET /api/federation/peers',
    responses: {
      'GET /api/federation/peers': { peers: [{ id: 'peer-fixture-1', url: 'http://host-a.example.test', trust_level: 'medium', registered_at: AT, last_seen: AT, metadata: {} }] },
      'GET /api/federation/capabilities': { capabilities: [] },
    },
    shows: 'http://host-a.example.test',
  },
  '/consensus-debates': {
    primary: 'GET /api/council/sessions',
    responses: {
      'GET /api/council/sessions': [{
        id: 'session-fixture-1', task_description: 'Fixture debate alpha', status: 'completed', final_output: null,
        final_confidence: null, cost_dollars: 0, token_usage: 0,
      }],
    },
    shows: 'Fixture debate alpha',
  },
  '/cognitive': {
    primary: 'GET /api/cognitive/stats',
    responses: { 'GET /api/cognitive/stats': COGNITIVE_STATS, 'GET /api/cognitive/meta-learning': { records: [] } },
    shows: '4217',
  },
  '/self-driving': {
    primary: 'GET /api/cognitive/stats',
    responses: {
      'GET /api/cognitive/stats': COGNITIVE_STATS,
      'GET /api/memory/stats': { total: 10, active: 8, candidates: 1, archived: 1, decayed: 0, avgRelevance: 0.5, totalRelations: 3 },
      'GET /api/meta/stats': { enabled: false },
      'GET /api/compliance/status': { totalAuditEntries: 20, chainIntegrity: true, lastReportScore: 0.9, lastReportStatus: 'pass' },
    },
    shows: '4217',
  },
  '/explainers': {
    primary: 'GET /api/explainer/fleet/overview',
    responses: {
      'GET /api/explainer/fleet/status': {
        total_repositories: 1, active_repositories: 1, pending_jobs: 0, running_jobs: 0, completed_today: 0, failed_today: 0, paused: false,
        budget: { llm_calls_used: 0, llm_calls_remaining: 10, github_api_calls_used: 0, github_api_calls_remaining: 10, git_ops_used: 0, git_ops_remaining: 10 },
      },
      'GET /api/explainer/fleet/overview': {
        repositories: [{
          id: 'repo-fixture-1', full_name: 'djimit/djimitflo', priority_tier: 1, language: 'TypeScript', license: null, stargazers_count: 0,
          open_issues_count: 0, last_commit_at: null, last_commit_sha: null, is_active: 1, last_generated: null,
        }],
      },
      'GET /api/explainer/fleet/health-drift': { drift_count: 0, drift: [] },
      'GET /api/explainer/review-queue': { count: 0, items: [] },
      'GET /api/explainer/fleet/calibration-stats': { ratings: 0 },
    },
    shows: 'djimit/djimitflo',
  },
};
