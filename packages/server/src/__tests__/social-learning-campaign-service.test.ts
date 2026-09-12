import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { SocialLearningCampaignService } from '../services/social-learning-campaign-service';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};

function worldlabEvidence(campaignId: string, inputReportHash: string): Record<string, unknown> {
  const core = {
    schema: 'openmythos.worldlab.social-learning-replay.v1', campaign_id: campaignId, status: 'PASS',
    source_commit: 'c'.repeat(40), input_report_hash: inputReportHash, trajectories: 2, failures: [],
    causal_claim_supported: true, interpretation: 'Randomized intervention independently supported the causal claim.',
  };
  return { ...core, evidence_hash: `sha256:${createHash('sha256').update(canonical(core)).digest('hex')}` };
}

function message(db: Database.Database, id: string, from: string, to: string, action: string, thread: string, at: string, answer: string, evidence: string[]): void {
  db.prepare(`INSERT INTO agent_messages (id, from_agent, to_agent, type, payload_json, timestamp, ttl, status)
    VALUES (?, ?, ?, ?, ?, ?, 86400, 'read')`).run(id, from, to, action === 'social.learning' ? 'knowledge' : 'result', JSON.stringify({
      action, thread_id: thread, evidence,
      params: {
        answer, uncertainty: 'The magnitude remains uncertain.', falsifiable_next_step: 'Compare a held-out outcome.',
        creative_alternative: 'Use a blinded negative control.', stop_condition: 'Stop when the interval crosses zero.',
        runtime: from === 'agent-a' ? 'runtime-a' : 'runtime-b', model_id: from === 'agent-a' ? 'model-a' : 'model-b',
        response_kind: 'actual_runtime', effect_scope: 'isolated', external_side_effects: false,
      },
    }), at);
}

function pair(db: Database.Database, index: number, at: string): string {
  const thread = `social:confirm-${index}`;
  message(db, `baseline-${index}`, 'agent-a', 'agent-b', 'social.response', thread, at, 'Independent baseline approach without corroboration.', [`claim:${index}`, `message:question-a-${index}`, 'runtime:agent-a:runtime-a']);
  message(db, `peer-${index}`, 'agent-b', 'agent-a', 'social.response', thread, at, 'Verify evidence provenance using a blinded control group.', [`claim:${index}`, `message:question-b-${index}`, 'runtime:agent-b:runtime-b']);
  message(db, `learning-${index}`, 'agent-a', 'agent-b', 'social.learning', thread, at, 'I revise the proposal: verify evidence provenance using a blinded control group.', [`claim:${index}`, `message:question-b-${index}`, 'runtime:agent-b:runtime-b', `message:peer-${index}`, 'runtime:agent-a:runtime-a']);
  const reflection = `reflection-${index}`;
  db.prepare(`INSERT INTO reflection_candidates (id, source_type, source_ref, lesson, status, sensitivity, evidence_refs_json, metadata)
    VALUES (?, 'trace', ?, 'verified learning', 'candidate', 'normal', '[]', ?)`)
    .run(reflection, `message:learning-${index}`, JSON.stringify({ empirical_status: 'UNDETERMINED', promotion_allowed: false, actual_runtime: true }));
  return reflection;
}

describe('SocialLearningCampaignService', () => {
  it('pre-registers a paired campaign and only emits a goal batch after all evidence is supported', () => {
    const db = createTestDb();
    try {
      message(db, 'pilot', 'agent-a', 'agent-b', 'social.response', 'social:pilot', '2025-12-31T10:00:00.000Z', 'pilot', []);
      const service = new SocialLearningCampaignService(db);
      const start = service.start({ campaign_id: 'social-confirmatory-1', started_at: '2026-01-01T00:00:00.000Z', days: 7, minimum_pairs: 2, runtime_commit: 'a'.repeat(40), analyzer_commit: 'b'.repeat(40) });
      expect(start.state.manifest).toMatchObject({ phase: 'CONFIRMATORY', pilot_snapshot: { threads: 1, responses: 1, learnings: 0 } });
      expect(service.start({ campaign_id: 'social-confirmatory-1', started_at: '2026-01-01T00:00:00.000Z', runtime_commit: 'a'.repeat(40), analyzer_commit: 'b'.repeat(40) }).duplicate).toBe(true);

      const first = pair(db, 1, '2026-01-02T00:00:00.000Z');
      const second = pair(db, 2, '2026-01-03T00:00:00.000Z');
      for (const [index, candidate] of [first, second].entries()) {
        db.prepare(`INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'outcome.observed', 'test', ?, ?)`)
          .run(`outcome-${index}`, `2026-01-0${index + 4}T00:00:00.000Z`, JSON.stringify({ candidate_id: candidate, value: 1, baseline: 0.5, direction: 'increase', causal_status: 'randomized' }));
      }
      const running = service.tick({ observed_at: '2026-01-05T00:00:00.000Z' });
      expect(running).toMatchObject({ status: 'RUNNING', signals: { peer_learning: 'SUPPORTED', operational_outcome_lift: 'SUPPORTED' }, independent_checker: { status: 'PASS' }, promotion: { allowed: false }, goal_batch: null });
      expect(running.pairs).toHaveLength(2);
      expect(running.pairs[0]).not.toHaveProperty('answer');
      expect(running.metrics.falsifiability_specificity).toMatchObject({ n: 2 });
      expect(running.metrics.falsifiability_specificity.mean).toBeGreaterThan(0);

      const complete = service.tick({ observed_at: '2026-01-08T00:00:00.000Z', worldlab: worldlabEvidence('social-confirmatory-1', running.report_hash) });
      expect(complete.status).toBe('SUPPORTED');
      expect(complete.promotion.allowed).toBe(false);
      expect(complete.goal_batch).toMatchObject({ schema: 'djimit.openmythos.worldlab.goal.v1', waves: [{ ordered_goals: [{ metadata: { promotion_eligible: false } }] }] });
      expect(db.prepare("SELECT COUNT(*) AS count FROM external_events WHERE event_type = 'social.campaign.finalized'").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it('records one append-only pre-evidence measurement amendment and refuses changes after evidence', () => {
    const db = createTestDb();
    try {
      const service = new SocialLearningCampaignService(db);
      const started = service.start({ campaign_id: 'social-confirmatory-amend', started_at: '2026-01-01T00:00:00.000Z', days: 7, minimum_pairs: 2, runtime_commit: 'a'.repeat(40), analyzer_commit: 'b'.repeat(40) });
      const amended = service.amendBeforeEvidence({ analyzer_commit: 'c'.repeat(40), amended_at: '2026-01-01T00:01:00.000Z' });
      expect(amended).toMatchObject({ duplicate: false, previous_manifest_hash: started.manifest_hash });
      expect(amended.state.manifest).toMatchObject({
        dependent_variables: expect.arrayContaining(['falsifiability specificity', 'explicit correction signal']),
        provenance: { analyzer_commit: 'c'.repeat(40) },
        amendments: [{ previous_manifest_hash: `sha256:${started.manifest_hash}` }],
      });
      expect(service.amendBeforeEvidence({ analyzer_commit: 'c'.repeat(40), amended_at: '2026-01-01T00:02:00.000Z' }).duplicate).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS count FROM external_events WHERE event_type = 'social.campaign.amended'").get()).toEqual({ count: 1 });

      message(db, 'after-start', 'agent-a', 'agent-b', 'social.response', 'social:after-start', '2026-01-01T00:03:00.000Z', 'evidence now exists', []);
      expect(() => service.amendBeforeEvidence({ analyzer_commit: 'd'.repeat(40), amended_at: '2026-01-01T00:04:00.000Z' })).toThrow('SOCIAL_CAMPAIGN_ALREADY_AMENDED');
    } finally { db.close(); }
  });

  it('refuses a measurement amendment once confirmatory evidence exists', () => {
    const db = createTestDb();
    try {
      const service = new SocialLearningCampaignService(db);
      service.start({ campaign_id: 'social-confirmatory-late-amend', started_at: '2026-01-01T00:00:00.000Z', days: 7, minimum_pairs: 2, runtime_commit: 'a'.repeat(40), analyzer_commit: 'b'.repeat(40) });
      message(db, 'after-start', 'agent-a', 'agent-b', 'social.response', 'social:after-start', '2026-01-01T00:01:00.000Z', 'evidence now exists', []);
      expect(() => service.amendBeforeEvidence({ analyzer_commit: 'c'.repeat(40), amended_at: '2026-01-01T00:02:00.000Z' })).toThrow('SOCIAL_CAMPAIGN_AMENDMENT_AFTER_EVIDENCE');
    } finally { db.close(); }
  });

  it('waits for WorldLab and fails closed on invalid evidence', () => {
    const db = createTestDb();
    try {
      const service = new SocialLearningCampaignService(db);
      service.start({ campaign_id: 'social-confirmatory-2', started_at: '2026-01-01T00:00:00.000Z', days: 1, minimum_pairs: 2, runtime_commit: 'a'.repeat(40), analyzer_commit: 'b'.repeat(40) });
      expect(service.tick({ observed_at: '2026-01-02T00:00:00.000Z' }).status).toBe('AWAITING_ASSURANCE');
      expect(() => service.tick({ observed_at: '2026-01-02T00:00:00.000Z', worldlab: { status: 'PASS' } })).toThrow('SOCIAL_CAMPAIGN_WORLDLAB_EVIDENCE_INVALID');
      expect(db.prepare('SELECT COUNT(*) AS count FROM reflection_candidates').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });
});
