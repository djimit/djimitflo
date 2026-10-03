import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { addedLines, checkLoopPrs } from '../services/merge-survival';

const NOW = new Date('2026-10-30T12:00:00Z');
const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv;
const PATCH = '@@ -0,0 +1,3 @@\n+it("adds two", () => {\n+  expect(add(1, 1)).toBe(2);\n+});';

function seed() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const run = (id: string, pr: number) => {
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run(id, JSON.stringify({ pr_url: `https://github.com/o/r/pull/${pr}` }));
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'remote', 'completed', ?, datetime('now'), datetime('now'))")
      .run(`m-${id}`, id, JSON.stringify({ model: 'workstation/atomic@llama-router', prompt_hash: 'abc123' }));
  };
  run('survived', 1); run('rewritten', 2); run('rejected', 3); run('young', 4); run('open', 5);
  return db;
}

it('D1: added lines are the PR content that must survive (blank lines and bare braces ignored)', () => {
  expect(addedLines([{ filename: 'a.test.ts', patch: PATCH }, { filename: 'b.md' }]).get('a.test.ts')).toEqual(['it("adds two", () => {', 'expect(add(1, 1)).toBe(2);']);
});

it('D1: a merged PR survives only if its added lines are still on main after 14 d — a rewritten file is removed, not survived', async () => {
  const db = seed();
  const pulls: Record<string, object> = {
    1: { state: 'closed', merged_at: '2026-10-11T00:00:00Z', created_at: '2026-10-10T00:00:00Z' }, 2: { state: 'closed', merged_at: '2026-10-11T00:00:00Z', created_at: '2026-10-10T12:00:00Z' },
    3: { state: 'closed', merged_at: null }, 4: { state: 'closed', merged_at: '2026-10-25T00:00:00Z' }, 5: { state: 'open', merged_at: null },
  };
  const file = (text: string) => ({ ok: true, status: 200, json: async () => ({ content: Buffer.from(text).toString('base64'), encoding: 'base64' }) });
  const fetchImpl = vi.fn(async (url: string) => {
    const m = /pulls\/(\d+)(\/\w+)?$/.exec(url);
    if (m?.[2] === '/files') return { ok: true, status: 200, json: async () => [{ filename: `t${m[1]}.test.ts`, patch: PATCH }] };
    if (m?.[2] === '/commits') return { ok: true, status: 200, json: async () => [{ commit: { author: { name: 'djimitflo-loop' } } }, ...(m[1] === '1' ? [{ commit: { author: { name: 'reviewer' } } }] : [])] };
    if (m) return { ok: true, status: 200, json: async () => pulls[m[1]] };
    return url.includes('t1.test.ts') ? file('import x\nit("adds two", () => {\n  expect(add(1, 1)).toBe(2);\n});') : file('// rewritten by hand\nit("other", () => {});');
  }) as unknown as typeof fetch;
  expect(await checkLoopPrs(db, fetchImpl, env, NOW)).toEqual({ checked: 5, settled: 3 });
  const outcomes = db.prepare("SELECT task_id, success, evidence_refs_json FROM skill_outcomes WHERE domain = 'merge' ORDER BY task_id").all() as Array<{ task_id: string; success: number; evidence_refs_json: string }>;
  expect(outcomes.map((o) => [o.task_id, o.success])).toEqual([['rejected', 0], ['rewritten', 0], ['survived', 1]]);
  const survived = JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'survived'").get() as { metadata: string }).metadata).pr_outcome;
  expect(survived).toMatchObject({ state: 'merged', survived: true, retained: 1, human_commits: 1, review_latency_h: 24, attribution: { runtime: 'remote', prompt_hash: 'abc123' } });
  const rewritten = JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'rewritten'").get() as { metadata: string }).metadata).pr_outcome;
  expect(rewritten).toMatchObject({ survived: false, retained: 0 });
  // settled runs are never checked again; young (merged < 14 d) and open stay pending
  expect(await checkLoopPrs(db, fetchImpl, env, NOW)).toEqual({ checked: 2, settled: 0 });
});
