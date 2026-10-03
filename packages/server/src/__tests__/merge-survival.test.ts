import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { checkLoopPrs } from '../services/merge-survival';

const NOW = new Date('2026-10-30T12:00:00Z');
const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv;

function seed() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const run = (id: string, pr: number) => {
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run(id, JSON.stringify({ pr_url: `https://github.com/o/r/pull/${pr}` }));
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'remote', 'completed', '{\"model\":\"workstation/atomic@llama-router\"}', datetime('now'), datetime('now'))").run(`m-${id}`, id);
    db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'draft_pr_opened', 'info', 'x', ?, datetime('now'))").run(`e-${id}`, id, JSON.stringify({ files: [`packages/server/src/__tests__/${id}.test.ts`] }));
  };
  run('survived', 1); run('removed', 2); run('rejected', 3); run('young', 4); run('open', 5);
  return db;
}

it('EV4: loop PRs are settled once — merged and still on main after 14 d = success, removed or closed unmerged = failure', async () => {
  const db = seed();
  const pulls: Record<string, object> = {
    1: { state: 'closed', merged_at: '2026-10-11T00:00:00Z' }, 2: { state: 'closed', merged_at: '2026-10-11T00:00:00Z' },
    3: { state: 'closed', merged_at: null }, 4: { state: 'closed', merged_at: '2026-10-25T00:00:00Z' }, 5: { state: 'open', merged_at: null },
  };
  const fetchImpl = vi.fn(async (url: string) => {
    const pr = /pulls\/(\d+)$/.exec(url)?.[1];
    if (pr) return { ok: true, status: 200, json: async () => pulls[pr] };
    return url.includes('removed.test.ts') ? { ok: false, status: 404 } : { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  expect(await checkLoopPrs(db, fetchImpl, env, NOW)).toEqual({ checked: 5, settled: 3 });
  const outcomes = db.prepare("SELECT task_id, success, skill_id, model FROM skill_outcomes WHERE domain = 'merge' ORDER BY task_id").all();
  expect(outcomes).toEqual([
    { task_id: 'rejected', success: 0, skill_id: 'loop-maker:merge:remote', model: 'workstation/atomic@llama-router' },
    { task_id: 'removed', success: 0, skill_id: 'loop-maker:merge:remote', model: 'workstation/atomic@llama-router' },
    { task_id: 'survived', success: 1, skill_id: 'loop-maker:merge:remote', model: 'workstation/atomic@llama-router' },
  ]);
  // settled runs are never checked again; young (merged < 14 d) and open stay pending
  fetchImpl.mockClear?.();
  expect(await checkLoopPrs(db, fetchImpl, env, NOW)).toEqual({ checked: 2, settled: 0 });
});
