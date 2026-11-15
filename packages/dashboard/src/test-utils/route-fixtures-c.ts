import type { PageFixture } from './route-fixtures';
import type {
  ExpertSummary,
  KnowledgeOverview,
  SkillCardsView,
  SocialCommons,
} from '../lib/api';

const AT = '2026-10-01T12:00:00Z';

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

export const FIXTURES: Record<string, PageFixture> = {
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
};
