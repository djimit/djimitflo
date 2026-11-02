import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { checkLoopPrs, settlementState } from '../services/merge-survival';
import { supersedingProposal } from '../services/merge-superseded';
import { fitnessPosterior } from '../services/fitness-view';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { operatorCockpit } from '../services/operator-cockpit';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

// Prod 19-10: #684/#626/#670/#683 were closed unmerged as SUPERSEDED (the proposal was requeued, the copy verified and
// opened a replacement PR) and still scored a merge 0. Superseded closes are no verdict; genuine rejections still are.
const NOW = new Date('2026-10-19T12:00:00Z');
const ENV = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv;
const T = '2026-10-10T00:00:00Z';

let db: Database.Database;
afterEach(() => db?.close());
function fresh() { db?.close(); db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); return db; }
const proposal = (id: string, status: string, refs: string[] = [], created = T) => {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, ?, ?, ?)`).run(id, `t ${id}`, status, JSON.stringify(refs), created, created);
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`)
    .run(`g-${id}`, id, created, created);
};
const run = (id: string, pid: string, meta: Record<string, unknown>) => {
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', ?, '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, `g-${pid}`, JSON.stringify(meta), T, T);
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'codex', 'completed', ?, ?, ?)")
    .run(`m-${id}`, id, JSON.stringify({ genome_id: 'gen1' }), T, T);
};
const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
/** every PR closed unmerged, except the replacement PRs (≥ 800) which are still open */
const closedFetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ state: Number(/pulls\/(\d+)$/.exec(url)?.[1]) >= 800 ? 'open' : 'closed', merged_at: null }) })) as unknown as typeof fetch;
const outcomeOf = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata: string }).metadata).pr_outcome;
const mergeRows = () => db.prepare("SELECT task_id, success FROM skill_outcomes WHERE domain = 'merge' ORDER BY task_id").all();

describe('merge survival poller: a superseded close is settled, not scored', () => {
  it('requeue copy verified → not_scored superseded_by_requeue, successor recorded, no merge outcome, settlement terminal', async () => {
    fresh();
    proposal('p-orig', 'verified'); run('r-orig', 'p-orig', { pr_url: pr(684) });
    proposal('p-copy', 'verified', ['requeue-of:p-orig', 'requeue-by:operator'], '2026-10-12T00:00:00Z'); run('r-copy', 'p-copy', { pr_url: pr(900) });
    expect(await checkLoopPrs(db, closedFetch, ENV, NOW)).toMatchObject({ settled: 1 });
    const o = outcomeOf('r-orig');
    expect(o).toMatchObject({ state: 'closed_unmerged', not_scored: 'superseded_by_requeue', superseded_by: 'p-copy' });
    expect(o.settled_at).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) n FROM skill_outcomes WHERE task_id = 'r-orig'").get()).toEqual({ n: 0 });
    expect(settlementState(T, o, NOW.getTime())).toMatchObject({ state: 'OPEN_BLOCKED', terminal: true });
  });

  it('no successor → genuine rejection, still a scored 0', async () => {
    fresh();
    proposal('p-g', 'verified'); run('r-g', 'p-g', { pr_url: pr(700) });
    await checkLoopPrs(db, closedFetch, ENV, NOW);
    expect(outcomeOf('r-g').not_scored).toBeUndefined();
    expect(mergeRows()).toEqual([{ task_id: 'r-g', success: 0 }]);
  });

  it('a requeue copy that neither verified nor opened a PR does not supersede', () => {
    fresh();
    proposal('p-o', 'verified'); run('r-o', 'p-o', { pr_url: pr(701) });
    proposal('p-c', 'regressed', ['requeue-of:p-o']); run('r-c', 'p-c', {});
    expect(supersedingProposal(db, 'r-o')).toBeNull();
  });

  it('follows requeue_of transitively: orig → copy (regressed, no PR) → copy of copy with its own PR', () => {
    fresh();
    proposal('p-0', 'verified'); run('r-0', 'p-0', { pr_url: pr(626) });
    proposal('p-1', 'regressed', ['requeue-of:p-0']); run('r-1', 'p-1', {});
    proposal('p-2', 'scheduled', ['requeue-of:p-1']); run('r-2', 'p-2', { pr_url: pr(879) });
    expect(supersedingProposal(db, 'r-0')).toBe('p-2');
    expect(supersedingProposal(db, 'r-2')).toBeNull(); // the successor itself has no successor
  });
  it('returns null when the lineage tables are unreadable (catch path)', () => {
    const bare = new Database(':memory:'); // no schema — prepare() throws
    try { expect(supersedingProposal(bare, 'r-x')).toBeNull(); } finally { bare.close(); }
  });
});

describe('readers of merge outcomes leave out historical superseded zeros (same rule)', () => {
  const seed = () => {
    fresh();
    new SkillEvolutionEngine(db);
    const closed = { state: 'closed_unmerged', merged_at: null, checked_at: '2026-10-18T00:00:00Z', settled_at: '2026-10-18T00:00:00Z' };
    proposal('p-s', 'verified'); run('r-s', 'p-s', { pr_url: pr(683), pr_outcome: closed }); // superseded (historical row, no not_scored)
    proposal('p-sc', 'verified', ['requeue-of:p-s']); run('r-sc', 'p-sc', { pr_url: pr(878) });
    proposal('p-g', 'verified'); run('r-g', 'p-g', { pr_url: pr(702), pr_outcome: closed }); // genuine rejection
    const ins = db.prepare(`INSERT INTO skill_outcomes (id, skill_id, agent_id, task_id, success, tokens_used, duration_ms, domain, model, evidence_refs_json, created_at)
      VALUES (?, 'loop-maker:merge:codex', 'a', ?, ?, 0, 0, 'merge', NULL, ?, '2026-10-18T00:00:00Z')`);
    for (const t of ['r-s', 'r-g']) ins.run(`o-${t}`, t, 0, JSON.stringify([`loop_run:${t}`, 'pr_outcome:closed_unmerged', 'genome:gen1']));
    ins.run('o-ok', 'r-ok', 1, JSON.stringify(['loop_run:r-ok', 'pr_outcome:merged:survived', 'genome:gen1'])); // a survived merge
  };

  it('fitness view: only the genuine rejection counts as a merge failure', () => {
    seed();
    const [row] = fitnessPosterior(db, 'test-gap', [{ runtime: 'codex' }], NOW.getTime(), {} as NodeJS.ProcessEnv);
    expect(row.sources.merge).toEqual({ n: 2, ok: 1 });
  });

  it('evolution evidence: merge_outcomes excludes it and reports it apart', () => {
    seed();
    expect(buildEvolutionEvidence(db, {} as NodeJS.ProcessEnv, NOW.getTime()).merge).toMatchObject({ merge_outcomes: 2, merge_outcomes_superseded: 1 });
  });

  it('cockpit production genomes, funnel run cost and the skill phenotype exclude it', () => {
    seed();
    const g = operatorCockpit(db, NOW.getTime(), {} as NodeJS.ProcessEnv).genomes.find((x) => x.skill_id === 'loop-maker:merge:codex');
    expect(g).toMatchObject({ scope: 'production', outcomes: 2, wins: 1 });
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    try { expect(new ImprovementFunnelService(db).compute().kpi).toMatchObject({ runs: 2, runSuccessRate: 0.5 }); } finally { vi.useRealTimers(); }
    expect(new SkillEvolutionEngine(db).measuredTraits('loop-maker:merge:codex').reliability).toBe(0.5);
    expect((db.prepare("SELECT COUNT(*) n FROM skill_outcomes WHERE domain = 'merge'").get() as { n: number }).n).toBe(3); // rows are never touched
  });
});
