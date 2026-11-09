import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, type Genome } from '../services/genome-registry';
import { genomeApplyRefs, notPromotedReason, trialledSpecies } from '../services/genome-apply';

const LINES = ['Run the narrowest failing test first.', 'Change one function at a time.'];
const SPECIES = 'atomic@llama-router';
const OTHER_SPECIES = 'codex@llama-router';
const now = '2026-10-11T10:00:00Z';

const genome = (id: string, status: string, lines: string[] = LINES): Genome => ({
  id, parent_id: BASELINE_GENOME, gene: 'strategy_lines', lines, origin: 'dream', status,
});

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('notPromotedReason', () => {
  it('rejects the baseline (no strategy lines)', () => {
    const baseline: Genome = { id: BASELINE_GENOME, parent_id: null, gene: 'baseline', lines: [], origin: 'baseline', status: 'active' };
    expect(notPromotedReason(db, baseline)).toBe('no strategy lines (baseline)');
  });

  it('rejects a genome with empty lines even when active and non-baseline', () => {
    expect(notPromotedReason(db, genome('g-empty', 'active', []))).toBe('no strategy lines (baseline)');
  });

  it('rejects a non-active genome by its status', () => {
    for (const status of ['trial', 'candidate', 'retired', 'inconclusive']) {
      expect(notPromotedReason(db, genome(`g-${status}`, status)), status).toBe(`status ${status}`);
    }
  });

  it('returns null when a gated promotion record exists (gate_policy + evidence_json, not hold_ineligible)', () => {
    const id = 'g-promoted';
    db.prepare(`INSERT INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, state, gate_policy, evidence_json, recorded_at)
      VALUES (?, ?, '2,3', 20, 8, 18, 2, 0.9, 'active', 'paired-holdout', '{}', ?)`).run(id, BASELINE_GENOME, now);
    expect(notPromotedReason(db, genome(id, 'active'))).toBeNull();
  });

  it('rejects an active genome with no promotion record', () => {
    expect(notPromotedReason(db, genome('g-none', 'active'))).toBe('no gated promotion record (genome_trial_results with gate_policy + evidence_json)');
  });

  it('rejects when the only record is a hold_ineligible state', () => {
    const id = 'g-hold';
    db.prepare(`INSERT INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, state, gate_policy, evidence_json, recorded_at)
      VALUES (?, ?, '2,3', 20, 8, 18, 2, 0.9, 'hold_ineligible', 'paired-holdout', '{}', ?)`).run(id, BASELINE_GENOME, now);
    expect(notPromotedReason(db, genome(id, 'active'))).toBe('no gated promotion record (genome_trial_results with gate_policy + evidence_json)');
  });

  it('rejects when gate_policy or evidence_json is missing', () => {
    const id = 'g-half';
    db.prepare(`INSERT INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, state, gate_policy, evidence_json, recorded_at)
      VALUES (?, ?, '2,3', 20, 8, 18, 2, 0.9, 'active', 'paired-holdout', NULL, ?)`).run(id, BASELINE_GENOME, now);
    expect(notPromotedReason(db, genome(id, 'active'))).toBe('no gated promotion record (genome_trial_results with gate_policy + evidence_json)');
  });

  it('returns "promotion record unreadable" when genome_trial_results is missing', () => {
    db.exec('DROP TABLE genome_trial_results');
    expect(notPromotedReason(db, genome('g-x', 'active'))).toBe('promotion record unreadable');
  });
});

describe('trialledSpecies', () => {
  const gymRun = (genomeId: string, species: string | null) => {
    const id = `r-${genomeId}-${species ?? 'null'}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(
      id, JSON.stringify({ gym: { species, genome: genomeId } }), now, now,
    );
    return id;
  };

  it('returns the distinct species of evolution-gym runs that carried the genome', () => {
    gymRun('g1', SPECIES);
    gymRun('g1', SPECIES); // duplicate species collapses
    gymRun('g1', OTHER_SPECIES);
    gymRun('g2', SPECIES); // different genome ignored
    expect(trialledSpecies(db, 'g1').sort()).toEqual([SPECIES, OTHER_SPECIES]);
  });

  it('ignores runs whose gym.species is null or missing', () => {
    gymRun('g1', null);
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(
      'r-no-species', JSON.stringify({ gym: { genome: 'g1' } }), now, now,
    );
    expect(trialledSpecies(db, 'g1')).toEqual([]);
  });

  it('ignores non-evolution-gym runs even if they carry the genome in metadata', () => {
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, 'test-gap-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(
      'r-other', JSON.stringify({ gym: { species: SPECIES, genome: 'g1' } }), now, now,
    );
    expect(trialledSpecies(db, 'g1')).toEqual([]);
  });

  it('returns an empty array when no run matches', () => {
    expect(trialledSpecies(db, 'g-none')).toEqual([]);
  });

  it('returns an empty array when loop_runs is unreadable', () => {
    db.exec('DROP TABLE loop_runs');
    expect(trialledSpecies(db, 'g1')).toEqual([]);
  });
});

describe('genomeApplyRefs', () => {
  it('returns no ref when there is no genome_apply entry', () => {
    expect(genomeApplyRefs({})).toEqual([]);
    expect(genomeApplyRefs({ genome_apply: undefined })).toEqual([]);
    expect(genomeApplyRefs({ genome_apply: null })).toEqual([]);
    expect(genomeApplyRefs({ genome_apply: 'not-an-object' })).toEqual([]);
  });

  it('returns no ref when genome_id is missing or not a string', () => {
    expect(genomeApplyRefs({ genome_apply: { arm: 'holdout' } })).toEqual([]);
    expect(genomeApplyRefs({ genome_apply: { arm: 'holdout', genome_id: 7 } })).toEqual([]);
  });

  it('tags a delivered treatment arm as treatment', () => {
    expect(genomeApplyRefs({ genome_apply: { arm: 'treatment', genome_id: 'g1', delivered: true } })).toEqual(['genome-apply:treatment:g1']);
  });

  it('tags an undelivered treatment arm as undelivered', () => {
    expect(genomeApplyRefs({ genome_apply: { arm: 'treatment', genome_id: 'g1', delivered: false } })).toEqual(['genome-apply:undelivered:g1']);
  });

  it('tags a holdout arm as holdout regardless of delivered', () => {
    expect(genomeApplyRefs({ genome_apply: { arm: 'holdout', genome_id: 'g1', delivered: false } })).toEqual(['genome-apply:holdout:g1']);
    expect(genomeApplyRefs({ genome_apply: { arm: 'holdout', genome_id: 'g1', delivered: true } })).toEqual(['genome-apply:holdout:g1']);
  });

  it('returns a single ref (one per receipt)', () => {
    const refs = genomeApplyRefs({ genome_apply: { arm: 'treatment', genome_id: 'g-x', delivered: true } });
    expect(refs).toHaveLength(1);
  });
});
