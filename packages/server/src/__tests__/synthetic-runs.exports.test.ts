import { describe, expect, it, vi } from 'vitest';
import { markSyntheticRun, realRunIdSql, realRunSql, syntheticRunSql } from '../services/synthetic-runs';

describe('syntheticRunSql', () => {
  it('interpolates the alias into the COALESCE / json_extract clause', () => {
    const sql = syntheticRunSql('r');
    expect(sql).toContain('NULLIF(r.metadata,');
    expect(sql).toContain("'$.synthetic'");
    expect(sql).toContain('r.loop_name');
    expect(sql).toContain('r.id');
  });

  it('references the repo-maintenance-loop + manual maker heuristic', () => {
    const sql = syntheticRunSql('r');
    expect(sql).toContain("'repo-maintenance-loop'");
    expect(sql).toContain("syn_l.runtime = 'manual'");
    expect(sql).toContain("syn_l.role = 'maker'");
  });

  it('produces a stable string for the same alias', () => {
    expect(syntheticRunSql('lr')).toBe(syntheticRunSql('lr'));
  });

  it('uses distinct aliases verbatim', () => {
    expect(syntheticRunSql('a')).not.toBe(syntheticRunSql('b'));
    expect(syntheticRunSql('syn_r')).toContain('syn_r.metadata');
  });
});

describe('realRunSql', () => {
  it('negates syntheticRunSql for the given alias', () => {
    expect(realRunSql('r')).toBe(`NOT ${syntheticRunSql('r')}`);
  });

  it('defaults the alias to loop_runs', () => {
    expect(realRunSql()).toBe(`NOT ${syntheticRunSql('loop_runs')}`);
  });
});

describe('realRunIdSql', () => {
  it('builds a NOT EXISTS subquery against loop_runs aliased syn_r', () => {
    const expr = 'wl.loop_run_id';
    const sql = realRunIdSql(expr);
    expect(sql.startsWith('NOT EXISTS (SELECT 1 FROM loop_runs syn_r WHERE syn_r.id = wl.loop_run_id AND ')).toBe(true);
    expect(sql).toContain(syntheticRunSql('syn_r'));
    expect(sql.endsWith(')')).toBe(true);
  });

  it('embeds an arbitrary id expression verbatim', () => {
    const sql = realRunIdSql('le.loop_run_id');
    expect(sql).toContain('syn_r.id = le.loop_run_id');
  });
});

describe('markSyntheticRun', () => {
  it('runs an idempotent json_set UPDATE with reason then runId', () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    const db = { prepare } as unknown as Parameters<typeof markSyntheticRun>[0];

    markSyntheticRun(db, 'run-xyz', 'pr_review');

    expect(prepare).toHaveBeenCalledTimes(1);
    const [sql] = prepare.mock.calls[0] as [string];
    expect(sql).toContain('UPDATE loop_runs');
    expect(sql).toContain("json_set(COALESCE(NULLIF(metadata, ''), '{}')");
    expect(sql).toContain("'$.synthetic'");
    expect(sql).toContain("'$.synthetic_reason'");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('pr_review', 'run-xyz');
  });

  it('is idempotent on re-marking (uses json_set, not raw overwrite)', () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    const db = { prepare } as unknown as Parameters<typeof markSyntheticRun>[0];

    markSyntheticRun(db, 'r1', 'pr_review');
    markSyntheticRun(db, 'r1', 'pr_review');

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, 'pr_review', 'r1');
    expect(run).toHaveBeenNthCalledWith(2, 'pr_review', 'r1');
  });
});