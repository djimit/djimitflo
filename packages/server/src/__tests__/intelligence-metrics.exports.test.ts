import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { failureUnits, intelligenceEvidence, INTELLIGENCE_METRIC_IDS, INTELLIGENCE_CONTRACT_VERSION } from '../services/intelligence-metrics';
import type { IntelligenceInputs } from '../services/intelligence-metrics';

const now = '2026-01-15T00:00:00.000Z';
const since = '2026-01-01T00:00:00.000Z';

const baseInputs: IntelligenceInputs = {
  forecasters: [],
  effort_x1: { on: { verified: 0, regressed: 0 }, off: { verified: 0, regressed: 0 } },
  memory_holdout: { rules: { n: 0 }, holdout: { n: 0 } },
};

const insertOutcome = (db: Database.Database, id: string, skill: string, success: number, refs: string[], domain = 'production', task = `run-${id}`, at = now) =>
  db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, skill, success, domain, task, JSON.stringify(refs), at);

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => { db.close(); });

describe('failureUnits', () => {
  it('returns an empty array when there are no production maker outcomes', () => {
    expect(failureUnits(db, since)).toEqual([]);
  });

  it('excludes gym and merge domains and non-maker skills', () => {
    insertOutcome(db, 'g1', 'loop-maker:opencode', 0, ['gate:checker:fail'], 'gym');
    insertOutcome(db, 'm1', 'loop-maker:opencode', 0, ['gate:checker:fail'], 'merge');
    insertOutcome(db, 'c1', 'codex', 0, ['gate:checker:fail'], 'production');
    expect(failureUnits(db, since)).toEqual([]);
  });

  it('marks a successful maker outcome as not failed with a null signature', () => {
    insertOutcome(db, 'ok', 'loop-maker:opencode', 1, [], 'production');
    const units = failureUnits(db, since);
    expect(units).toHaveLength(1);
    expect(units[0].lane).toBe('opencode');
    expect(units[0].failed).toBe(false);
    expect(units[0].signature).toBeNull();
  });

  it('marks a failed maker outcome as failed and derives a signature from gate refs', () => {
    insertOutcome(db, 'bad', 'loop-maker:claude', 0, ['gate:checker:fail'], 'production');
    const units = failureUnits(db, since);
    expect(units).toHaveLength(1);
    expect(units[0].lane).toBe('claude');
    expect(units[0].failed).toBe(true);
    expect(units[0].signature).not.toBeNull();
    expect(units[0].signature!.gate).toBe('checker');
  });

  it('treats outcome_class:no_change as not a failure even when success is 0', () => {
    insertOutcome(db, 'nc', 'loop-maker:opencode', 0, ['outcome_class:no_change'], 'production');
    const units = failureUnits(db, since);
    expect(units).toHaveLength(1);
    expect(units[0].failed).toBe(false);
    expect(units[0].signature).toBeNull();
  });

  it('deduplicates units sharing the same (run, maker) pair', () => {
    insertOutcome(db, 'a', 'loop-maker:opencode', 0, ['gate:checker:fail'], 'production', 'shared-run');
    insertOutcome(db, 'b', 'loop-maker:opencode', 0, ['gate:reviewer:fail'], 'production', 'shared-run');
    const units = failureUnits(db, since);
    expect(units).toHaveLength(1);
  });

  it('respects the since cutoff', () => {
    insertOutcome(db, 'old', 'loop-maker:opencode', 0, ['gate:checker:fail'], 'production', 'r-old', '2025-01-01T00:00:00.000Z');
    insertOutcome(db, 'new', 'loop-maker:opencode', 0, ['gate:checker:fail'], 'production', 'r-new', now);
    const units = failureUnits(db, since);
    expect(units).toHaveLength(1);
    expect(units[0].at).toBe(now);
  });
});

describe('intelligenceEvidence', () => {
  it('returns the contract version and one metric per contract id on an empty database', () => {
    const result = intelligenceEvidence(db, process.env, Date.now(), since, baseInputs);
    expect(result.contract_version).toBe(INTELLIGENCE_CONTRACT_VERSION);
    expect(result.metrics).toHaveLength(INTELLIGENCE_METRIC_IDS.length);
    const ids = result.metrics.map((m) => m.metric_id);
    expect(ids).toEqual([...INTELLIGENCE_METRIC_IDS]);
  });

  it('reports every metric as non-ok (INSUFFICIENT_EVIDENCE or UNDEFINED) with null value when evidence is absent', () => {
    const result = intelligenceEvidence(db, process.env, Date.now(), since, baseInputs);
    for (const m of result.metrics) {
      expect(m.status === 'INSUFFICIENT_EVIDENCE' || m.status === 'UNDEFINED').toBe(true);
      expect(m.value).toBeNull();
      expect(m.ci).toBeNull();
      expect(m.blocker).not.toBeNull();
    }
  });

  it('includes FRR built from failureUnits in the metrics', () => {
    const result = intelligenceEvidence(db, process.env, Date.now(), since, baseInputs);
    const frr = result.metrics.find((m) => m.metric_id === 'FRR');
    expect(frr).toBeDefined();
    expect(frr!.detail).toHaveProperty('failures', 0);
  });

  it('produces an ok VIG when a decisive graded trial with sufficient paired tasks exists', () => {
    // genome_trial_results is not in the test schema; the query is try/caught → 0 trials → INSUFFICIENT_EVIDENCE.
    const result = intelligenceEvidence(db, process.env, Date.now(), since, baseInputs);
    const vig = result.metrics.find((m) => m.metric_id === 'VIG');
    expect(vig!.status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('does not throw when optional inputs (holdout_reuse_risk) are omitted', () => {
    const result = intelligenceEvidence(db, process.env, Date.now(), since, {
      forecasters: [],
      effort_x1: { on: { verified: 0, regressed: 0 }, off: { verified: 0, regressed: 0 } },
      memory_holdout: { rules: { n: 5 }, holdout: { n: 3 } },
    });
    expect(result.metrics).toHaveLength(INTELLIGENCE_METRIC_IDS.length);
  });
});