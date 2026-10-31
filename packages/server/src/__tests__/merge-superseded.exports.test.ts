import { describe, expect, it } from 'vitest';
import {
  supersedingProposalSql,
  supersededMergeOutcomeSql,
} from '../services/merge-superseded';

describe('supersedingProposalSql', () => {
  it('returns a parenthesised recursive CTE scalar expression', () => {
    const sql = supersedingProposalSql('@run');
    expect(sql.startsWith('(WITH RECURSIVE sup_d(id) AS (')).toBe(true);
    expect(sql.endsWith('ORDER BY sup_c.created_at, sup_c.id LIMIT 1)')).toBe(true);
  });

  it('interpolates the run expression in every reference to the run id', () => {
    const sql = supersedingProposalSql('runs.id');
    // three references: seed row, NOT IN exclusion, and the sibling-PR EXISTS guard
    expect(sql).toContain('WHERE sup_r.id = runs.id AND sup_g.improvement_id IS NOT NULL');
    expect(sql).toContain('WHERE sup_r0.id = runs.id AND sup_g0.improvement_id IS NOT NULL');
    expect(sql).toContain('AND sup_r2.id <> runs.id AND json_extract(sup_r2.metadata, \'$.pr_url\') IS NOT NULL');
  });

  it('matches requeue descendants via evidence_refs_json and requires a verified status or an open PR', () => {
    const sql = supersedingProposalSql('@run');
    expect(sql).toContain("instr(sup_s.evidence_refs_json, '\"requeue-of:' || sup_d.id || '\"') > 0");
    expect(sql).toContain("sup_c.status IN ('verified', 'evaluating', 'applied')");
    expect(sql).toContain("json_extract(sup_r2.metadata, '$.pr_url') IS NOT NULL");
  });
});

describe('supersededMergeOutcomeSql', () => {
  it('returns a parenthesised boolean expression for the given alias', () => {
    const sql = supersededMergeOutcomeSql('so');
    expect(sql.startsWith('(')).toBe(true);
    expect(sql.endsWith('IS NOT NULL)')).toBe(true);
  });

  it('scopes to domain merge rows whose run PR was closed unmerged', () => {
    const sql = supersededMergeOutcomeSql('so');
    expect(sql).toContain("so.domain = 'merge'");
    expect(sql).toContain('WHERE sup_x.id = so.task_id');
    expect(sql).toContain("json_extract(sup_x.metadata, '$.pr_outcome.state') = 'closed_unmerged'");
  });

  it('delegates the successor check to supersedingProposalSql keyed on the outcome task id', () => {
    const sql = supersededMergeOutcomeSql('so');
    // the embedded scalar must be built from `${alias}.task_id`, not a bare placeholder
    expect(sql).toContain(supersedingProposalSql('so.task_id'));
    expect(sql).not.toContain('@run');
  });
});
