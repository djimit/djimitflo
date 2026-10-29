import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { operatorCockpit } from '../services/operator-cockpit';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';
import { makerTokenAccountingEvidence } from '../services/maker-token-accounting';
import { markSyntheticRun, realRunIdSql, realRunSql } from '../services/synthetic-runs';

/**
 * U3 (B-intelligence 10-29): the GitHub PR-review webhook writes bookkeeping loop runs (repo-maintenance-loop, a synthetic
 * 'manual' maker lease, a heuristic or LLM checker) — 51 % of loop runs, 68 % of leases. They are marked synthetic at write
 * time, older ones are recognised by loop name + manual maker, and every loop KPI aggregate counts real runs only.
 */
const DAY = 86_400_000;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();
let db: Database.Database;

// every run: interrupted (failed 7 d, stale), a skipped security review (gate-rule disagreement), its own repository path
function run(id: string, loop: string, repo: string, meta: Record<string, unknown>, leases: Array<{ role: string; runtime: string; tokens: number }>) {
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, gates_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'closed', 'interrupted', ?, ?, ?, ?, ?)`).run(id, loop, repo,
    JSON.stringify([{ name: 'tests', status: 'pass' }, { name: 'security_checker_verdict', status: 'skipped' }]), JSON.stringify(meta), iso(now - DAY), iso(now - 3 * DAY));
  leases.forEach((l, i) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`)
    .run(`${id}-${i}`, id, l.role, l.runtime, JSON.stringify({ runtime_usage: { total_tokens: l.tokens } }), iso(now - 3_600_000), iso(now - 3_600_000)));
}

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  run('r-real', 'test-gap', '/repo/a', {}, [{ role: 'maker', runtime: 'opencode', tokens: 1000 }]);
  // a repo-maintenance run with a real maker (e.g. federation) is real work
  run('r-fed', 'repo-maintenance-loop', '/repo/d', {}, [{ role: 'maker', runtime: 'opencode', tokens: 2000 }]);
  // marked at write time; the LLM review path's checker spends tokens
  run('r-syn', 'repo-maintenance-loop', '/repo/b', { synthetic: true, synthetic_reason: 'pr_review' },
    [{ role: 'maker', runtime: 'manual', tokens: 0 }, { role: 'checker', runtime: 'codex', tokens: 5000 }]);
  // historical (before the mark): repo-maintenance-loop + a manual maker lease
  run('r-hist', 'repo-maintenance-loop', '/repo/c', {}, [{ role: 'maker', runtime: 'manual', tokens: 0 }, { role: 'checker', runtime: 'manual', tokens: 7000 }]);
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, updated_at) VALUES ('si-1', 'test', 't', 'd', 'r', 'gap_analysis', 'verified', ?)").run(iso(now - DAY));
});
afterEach(() => db.close());

describe('U3: synthetic PR-review runs are excluded from loop KPI aggregates', () => {
  it('the shared SQL fragments: marked or historical PR-review runs are synthetic, everything else is real', () => {
    expect((db.prepare(`SELECT id FROM loop_runs r WHERE ${realRunSql('r')} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['r-fed', 'r-real']);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE ${realRunSql()}`).get() as { n: number }).n).toBe(2);
    expect((db.prepare(`SELECT id FROM worker_leases WHERE ${realRunIdSql('loop_run_id')} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['r-fed-0', 'r-real-0']);
    markSyntheticRun(db, 'r-fed', 'pr_review');
    expect(JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'r-fed'").get() as { metadata: string }).metadata)).toEqual({ synthetic: true, synthetic_reason: 'pr_review' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE ${realRunSql()}`).get() as { n: number }).n).toBe(1);
  });

  it('cockpit scorecard: failed runs and lease spend per verified change count real runs only', () => {
    const s = operatorCockpit(db, now, {}).scorecard;
    expect(s.runs_failed_7d).toBe(2);
    expect(s.tokens_per_verified_change_7d).toBe(3000); // 1000 + 2000, not + 5000 + 7000
  });

  it('funnel hygiene: stale runs count real runs only', () => {
    expect(new ImprovementFunnelService(db).compute().hygiene.staleRuns).toBe(2);
  });

  it('evolution evidence: maker token accounting, intelligence GTI repository paths and gate-rule disagreements count real runs only', () => {
    const tokens = makerTokenAccountingEvidence(db, iso(now - 7 * DAY));
    expect(tokens.by_runtime_model.map((g) => [g.runtime, g.leases])).toEqual([['opencode', 2]]);
    const e = buildEvolutionEvidence(db, {}, now);
    expect(e.maker_tokens.by_runtime_model.reduce((a, g) => a + g.leases, 0)).toBe(2);
    expect(e.intelligence.metrics.find((m) => m.metric_id === 'GTI')!.detail).toMatchObject({ repository_paths: 2 });
    expect(e.gate_rule_disagreements).toBe(2);
  });
});
