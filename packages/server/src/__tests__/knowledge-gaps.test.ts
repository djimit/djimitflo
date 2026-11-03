import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { CapabilityAcquisitionService } from '../services/capability-acquisition';
import { ExpertResolverService } from '../services/expert-resolver-service';
import { knowledgeGapEvidence, openKnowledgeGaps, recordAbstentionGap, recordFailureGaps } from '../services/knowledge-gaps';
import { interestProfile } from '../services/interest-feedback';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

let db: Database.Database;
let acquisition: CapabilityAcquisitionService;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const DAY = 86_400_000;
const SHADOW = { KNOWLEDGE_GAP_MODE: 'shadow' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  new SkillEvolutionEngine(db as never); // creates skill_outcomes
  db.exec('CREATE TABLE IF NOT EXISTS kb_pages (path TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)');
  acquisition = new CapabilityAcquisitionService(db as never, new SwarmIntelligenceService(db as never));
  acquisition.start();
});
afterEach(() => { acquisition.stop(); db.close(); });

/** n failed production maker outcomes with one recurring signature (gate + error class), each with a maker lease and its changed files */
function failures(n: number, gate: string, reason: string, prefix = gate) {
  for (let i = 0; i < n; i++) {
    const run = `run-${prefix}-${i}`;
    db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:test-gap:opencode', 0, 'loop', ?, ?, ?)")
      .run(`o-${prefix}-${i}`, run, JSON.stringify([`gate:${gate}:fail`, `evolve:reason:${reason}`]), new Date(NOW - (i + 1) * DAY).toISOString());
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'failed', ?)")
      .run(`l-${prefix}-${i}`, run, JSON.stringify({ changed_files: ['packages/server/src/services/snapshot.ts'] }));
  }
}
const gapRows = () => db.prepare("SELECT * FROM judgments WHERE judgment = 'knowledge_gap'").all() as Array<{ subject_type: string; mode: string; decision: string; answers_json: string }>;
const candidates = () => db.prepare("SELECT id, status, kind FROM swarm_capabilities WHERE id LIKE 'knowledge-gap:%'").all() as Array<{ id: string; status: string; kind: string }>;

it('K2: 3 recurrences of one failure signature in 14 d → exactly one knowledge gap and one candidate capability (idempotent)', () => {
  failures(3, 'snapshot-drift', 'snapshot serializer mismatch 42 at /tmp/x');
  expect(recordFailureGaps(db as never, SHADOW, NOW)).toHaveLength(1);
  expect(recordFailureGaps(db as never, SHADOW, NOW + DAY)).toHaveLength(0); // same signature within 14 d: no second gap
  const rows = gapRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ subject_type: 'failure_signature', mode: 'shadow', decision: 'open' });
  const a = JSON.parse(rows[0].answers_json);
  expect(a).toMatchObject({ source: 'failure_recurrence', lane: 'test-gap:opencode', gate: 'snapshot-drift', occurrences: 3,
    files: ['packages/server/src/services/snapshot.ts'] });
  expect(a.example_runs.sort()).toEqual(['run-snapshot-drift-0', 'run-snapshot-drift-1', 'run-snapshot-drift-2']);
  expect(candidates()).toEqual([{ id: `knowledge-gap:${a.signature}`, status: 'candidate', kind: 'skill' }]);
});

it('K2: 2 recurrences → no gap; runs attributed reviewer/environment failure do not count', () => {
  failures(2, 'snapshot-drift', 'snapshot serializer mismatch');
  expect(recordFailureGaps(db as never, SHADOW, NOW)).toEqual([]);
  failures(1, 'snapshot-drift', 'snapshot serializer mismatch', 'env');
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('oa', 'outcome_attribution', 'loop_run', 'run-env-0', 'x', 'annotation', 'environment_failure', 'r', ?)")
    .run(new Date(NOW).toISOString());
  expect(recordFailureGaps(db as never, SHADOW, NOW)).toEqual([]);
  expect(gapRows()).toHaveLength(0);
  expect(candidates()).toHaveLength(0);
});

it('K2: KNOWLEDGE_GAP_MODE off (default) records nothing', () => {
  failures(5, 'snapshot-drift', 'snapshot serializer mismatch');
  expect(recordFailureGaps(db as never, OFF, NOW)).toEqual([]);
  expect(recordAbstentionGap(db as never, { question: 'quantum annealing schedules', abstained: true, reason: 'no_capability_match' }, OFF, NOW)).toBeNull();
  expect(gapRows()).toHaveLength(0);
  expect(candidates()).toHaveLength(0);
  expect(knowledgeGapEvidence(db as never, OFF, NOW)).toMatchObject({ mode: 'off', status: 'insufficient', open: null, open_by_source: null, recurrences: null, oldest_age_days: null });
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'KNOWLEDGE_GAP_MODE', acting: false });
});

it('K2: an expert resolver abstention (no_capability_match) records one expert_abstention gap with the question terms', () => {
  const resolution = new ExpertResolverService(db as never).resolve('How do quantum annealing schedules compare?');
  expect(resolution).toMatchObject({ abstained: true, reason: 'no_capability_match' });
  const id = recordAbstentionGap(db as never, resolution, SHADOW, NOW);
  expect(id).toBeTruthy();
  expect(recordAbstentionGap(db as never, resolution, SHADOW, NOW + DAY)).toBeNull(); // same terms within 14 d
  expect(recordAbstentionGap(db as never, { question: 'x y z', abstained: true, reason: 'no_expert_above_floor' }, SHADOW, NOW)).toBeNull();
  const [gap] = openKnowledgeGaps(db as never, NOW);
  expect(gap).toMatchObject({ id, source: 'expert_abstention', terms: ['quantum', 'annealing', 'schedules', 'compare'] });
  expect(candidates()).toEqual([{ id: gap.capability_id, status: 'candidate', kind: 'skill' }]);
  expect(knowledgeGapEvidence(db as never, SHADOW, NOW)).toMatchObject({ mode: 'shadow', status: 'ok', open: 1,
    open_by_source: { failure_recurrence: 0, expert_abstention: 1 }, recurrences: 0, oldest_age_days: 0, capability_candidates: 1 });
});

/** n scout discoveries matched on `hits`, `yes` of them judged relevant (the yield baseline needs ≥ 20 on the static list). */
function scouted(prefix: string, hits: string, n: number, yes: number) {
  for (let i = 0; i < n; i++) {
    const ref = `arxiv:${prefix}.${i}`;
    db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'discovery.paper', 'djimitflo-scout', ?, ?)")
      .run(`e-${ref}`, new Date(NOW - 2 * DAY).toISOString(), JSON.stringify({ ref, note: `scout match: ${hits}` }));
    db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'discovery_relevance', 'discovery_rejected', ?, 'h', 'shadow', ?, NULL, ?)")
      .run(`j-${ref}`, ref, i < yes ? 'yes' : 'uncertain', new Date(NOW - DAY).toISOString());
  }
}

it('K2: in shadow the interest profile is unchanged except gap_trial_candidates; gap terms are never published', () => {
  scouted('s', 'mutation', 40, 8);
  failures(3, 'snapshot-drift', 'snapshot serializer mismatch');
  recordAbstentionGap(db as never, { question: 'quantum annealing schedules', abstained: true, reason: 'no_capability_match' }, SHADOW, NOW - 60_000);
  recordFailureGaps(db as never, SHADOW, NOW);
  const off = interestProfile(db as never, NOW, OFF);
  const shadow = interestProfile(db as never, NOW, SHADOW);
  expect(off).not.toHaveProperty('gap_trial_candidates');
  const { gap_trial_candidates, ...rest } = shadow;
  expect(rest).toEqual(off);
  // the ECO-3 gap term 'snapshot' already holds the one gap trial slot, so the failure gap is 'already in profile' and the
  // abstention gap finds no free slot: neither bypasses the slot or the yield gate
  expect(gap_trial_candidates).toEqual([
    expect.objectContaining({ term: 'quantum', source: 'expert_abstention', would_take_slot: false, reason: 'no free gap trial slot' }),
    expect.objectContaining({ term: 'snapshot', source: 'failure_recurrence', would_take_slot: false, reason: 'already in profile' }),
  ]);
  expect(shadow.terms).not.toContain('quantum');
});

it('K2: with no measured baseline no gap term would take a slot', () => {
  recordAbstentionGap(db as never, { question: 'quantum annealing schedules', abstained: true, reason: 'no_capability_match' }, SHADOW, NOW);
  expect(interestProfile(db as never, NOW, SHADOW).gap_trial_candidates).toEqual([
    expect.objectContaining({ term: 'quantum', would_take_slot: false, reason: 'no measured baseline' }),
  ]);
});

it('K2: an open gap would take a free gap trial slot (recorded only)', () => {
  scouted('s', 'mutation', 40, 8);
  recordAbstentionGap(db as never, { question: 'quantum annealing schedules', abstained: true, reason: 'no_capability_match' }, SHADOW, NOW);
  const p = interestProfile(db as never, NOW, SHADOW);
  expect(p.gap_trial_candidates).toEqual([expect.objectContaining({ term: 'quantum', would_take_slot: true, reason: 'would take the gap trial slot' })]);
  expect(p.terms).not.toContain('quantum');
});
