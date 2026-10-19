import { describe, expect, it } from 'vitest';
import {
  notFallbackOutcomeSql,
  notFallbackGoalSql,
  notFallbackRunSql,
  FALLBACK_REF,
} from '../services/ollama-outage-fallback';

describe('ollama-outage-fallback exports — SQL fragment generators', () => {
  it('notFallbackOutcomeSql produces a COALESCE…NOT LIKE clause for the given alias', () => {
    const sql = notFallbackOutcomeSql('so');
    expect(sql).toBe(`COALESCE(so.evidence_refs_json, '') NOT LIKE '%"${FALLBACK_REF}"%'`);
    expect(sql).toContain(FALLBACK_REF);
    expect(sql).toContain('evidence_refs_json');
    expect(sql).toContain('NOT LIKE');
  });

  it('notFallbackOutcomeSql works with any alias name', () => {
    const sql = notFallbackOutcomeSql('outcome_alias_42');
    expect(sql).toContain('outcome_alias_42.evidence_refs_json');
  });

  it('notFallbackGoalSql produces a NOT EXISTS subquery scoped to the goal expression', () => {
    const sql = notFallbackGoalSql('g.id');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('loop_runs fr JOIN worker_leases fl ON fl.loop_run_id = fr.id');
    expect(sql).toContain('fr.goal_id = g.id');
    expect(sql).toContain("json_extract(fl.metadata, '$.runtime_fallback') IS NOT NULL");
  });

  it('notFallbackRunSql produces a NOT EXISTS subquery scoped to the run expression', () => {
    const sql = notFallbackRunSql("'run-abc'");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('worker_leases fl');
    expect(sql).toContain("fl.loop_run_id = 'run-abc'");
    expect(sql).toContain("json_extract(fl.metadata, '$.runtime_fallback') IS NOT NULL");
  });

  it('all three fragments reference runtime_fallback metadata (the exclusion key)', () => {
    expect(notFallbackOutcomeSql('x')).toContain(FALLBACK_REF);
    expect(notFallbackGoalSql('y')).toContain('$.runtime_fallback');
    expect(notFallbackRunSql('z')).toContain('$.runtime_fallback');
  });
});
