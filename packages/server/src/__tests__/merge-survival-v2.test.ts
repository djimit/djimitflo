import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { addedLinesV2, checkLoopPrs } from '../services/merge-survival';

const NOW = new Date('2026-12-30T12:00:00Z');
const V2 = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', MERGE_SURVIVAL_V2: 'true' } as NodeJS.ProcessEnv;
const LINE = (i: number) => `expect(value${i}).toBe(${i});`;

type Files = Array<{ filename: string; status?: string; patch?: string; previous_filename?: string }>;
interface Pr { pull: object; files?: Files; commits?: number; contents?: Record<string, { status?: number; content?: string; encoding?: string }> }

function db1(created = '2026-10-10T00:00:00Z', meta: Record<string, unknown> = {}) {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('r1', 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(JSON.stringify({ pr_url: 'https://github.com/o/r/pull/7', ...meta }), created, created);
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('m1', 'r1', 'maker', 'opencode', 'completed', '{}', datetime('now'), datetime('now'))").run();
  return db;
}
function fake(pr: Pr) {
  const calls: string[] = [];
  const page = (all: unknown[], url: string) => {
    const p = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1'); const per = Number(/[?&]per_page=(\d+)/.exec(url)?.[1] ?? '30');
    return all.slice((p - 1) * per, p * per);
  };
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const path = url.replace('https://api.github.com/repos/o/r/', '');
    if (path.startsWith('pulls/7/files')) return { ok: true, status: 200, json: async () => page(pr.files ?? [], url) };
    if (path.startsWith('pulls/7/commits')) return { ok: true, status: 200, json: async () => page(Array.from({ length: pr.commits ?? 1 }, (_, i) => ({ commit: { author: { name: i === 0 ? 'djimitflo-loop' : 'human' } } })), url) };
    if (path.startsWith('pulls/7')) return { ok: true, status: 200, json: async () => pr.pull };
    const file = decodeURIComponent(path.replace(/^contents\//, '').replace(/\?ref=.*$/, ''));
    const c = pr.contents?.[file];
    if (!c) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: (c.status ?? 200) < 400, status: c.status ?? 200, json: async () => ({ content: c.content, encoding: c.encoding }) };
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}
const b64 = (s: string) => Buffer.from(s).toString('base64');
const outcome = (db: Database.Database) => JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'r1'").get() as { metadata: string }).metadata).pr_outcome;
const merged = { state: 'closed', merged_at: '2026-10-11T00:00:00Z', created_at: '2026-10-10T00:00:00Z' };

it('RX-10: with the flag off the v1 path is unchanged (no paging params, no msv:2 ref)', async () => {
  const db = db1('2026-11-15T00:00:00Z'); // inside v1's 60-day run window
  const { fetchImpl, calls } = fake({ pull: merged, files: [{ filename: 'a.test.ts', patch: `+${LINE(1)}` }], contents: { 'a.test.ts': { content: b64(LINE(1)), encoding: 'base64' } } });
  await checkLoopPrs(db, fetchImpl, { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv, NOW);
  expect(calls.some((u) => u.includes('per_page'))).toBe(false);
  expect((db.prepare("SELECT evidence_refs_json AS e FROM skill_outcomes").get() as { e: string }).e).not.toContain('msv:2');
});

it('RX-10: files and commits are paginated (per_page=100) — a 130-file PR scores every file', async () => {
  const db = db1();
  const files = Array.from({ length: 130 }, (_, i) => ({ filename: `f${i}.test.ts`, patch: `+${LINE(i)}` }));
  const contents = Object.fromEntries(files.map((f, i) => [f.filename, { content: b64(i < 65 ? LINE(i) : '// rewritten'), encoding: 'base64' }]));
  const { fetchImpl, calls } = fake({ pull: merged, files, commits: 120, contents });
  expect(await checkLoopPrs(db, fetchImpl, V2, NOW)).toEqual({ checked: 1, settled: 1 });
  expect(calls.filter((u) => u.includes('pulls/7/files')).length).toBe(2);
  expect(outcome(db)).toMatchObject({ version: 2, retained: 0.5, survived: true, human_commits: 119 });
  expect((db.prepare("SELECT evidence_refs_json AS e FROM skill_outcomes").get() as { e: string }).e).toContain('msv:2');
});

it('RX-10: a PR whose run is older than 60 d still settles (the window follows merged_at, not run creation)', async () => {
  const db = db1('2026-08-01T00:00:00Z');
  const { fetchImpl } = fake({ pull: merged, files: [{ filename: 'a.test.ts', patch: `+${LINE(1)}` }], contents: { 'a.test.ts': { content: b64(LINE(1)), encoding: 'base64' } } });
  expect(await checkLoopPrs(db, fetchImpl, V2, NOW)).toEqual({ checked: 1, settled: 1 });
});

it('RX-10: a file over 1 MB (encoding none / no content) is unknown, not "0 kept"', async () => {
  const db = db1();
  const { fetchImpl } = fake({ pull: merged, files: [{ filename: 'big.json', patch: `+${LINE(1)}` }, { filename: 'a.test.ts', patch: `+${LINE(2)}` }],
    contents: { 'big.json': { content: '', encoding: 'none' }, 'a.test.ts': { content: b64(LINE(2)), encoding: 'base64' } } });
  await checkLoopPrs(db, fetchImpl, V2, NOW);
  expect(outcome(db)).toMatchObject({ retained: 1, survived: true, unknown_files: 1 });
});

it('RX-10: a renamed file is read at its new path (previous_filename is not the lookup key)', async () => {
  const db = db1();
  const { fetchImpl, calls } = fake({ pull: merged, files: [{ filename: 'new/a.test.ts', previous_filename: 'old/a.test.ts', status: 'renamed', patch: `+${LINE(1)}` }],
    contents: { 'new/a.test.ts': { content: b64(LINE(1)), encoding: 'base64' } } });
  await checkLoopPrs(db, fetchImpl, V2, NOW);
  expect(calls.some((u) => u.includes('contents/new/a.test.ts'))).toBe(true);
  expect(outcome(db)).toMatchObject({ retained: 1, survived: true });
});

it('RX-10: deletion-only and docs-only PRs settle as not_scored with a reason — no failure outcome', async () => {
  const del = db1();
  await checkLoopPrs(del, fake({ pull: merged, files: [{ filename: 'dead.ts', status: 'removed', patch: '-old line here' }] }).fetchImpl, V2, NOW);
  expect(outcome(del)).toMatchObject({ state: 'merged', not_scored: 'deletion_only' });
  expect(outcome(del).settled_at).toBeTruthy();
  expect(del.prepare("SELECT COUNT(*) n FROM skill_outcomes").get()).toEqual({ n: 0 });
  const docs = db1();
  await checkLoopPrs(docs, fake({ pull: merged, files: [{ filename: 'docs/guide.md', patch: `+${LINE(1)}` }, { filename: 'README.md', patch: `+${LINE(2)}` }] }).fetchImpl, V2, NOW);
  expect(outcome(docs)).toMatchObject({ not_scored: 'docs_only' });
  expect(docs.prepare("SELECT COUNT(*) n FROM skill_outcomes").get()).toEqual({ n: 0 });
});

it('RX-10: added lines that start with "++" are content, only "+++ a/…" headers are dropped', () => {
  const patch = ['+++ b/a.ts', '+++counter;', '++i_is_long_enough;', `+${LINE(3)}`].join('\n');
  expect(addedLinesV2([{ filename: 'a.ts', patch }]).get('a.ts')).toEqual(['++counter;', '+i_is_long_enough;', LINE(3)]);
});

it('RX-10: a stale_loop closure (queue hygiene) is not a quality failure — settled not_scored, no outcome', async () => {
  const db = db1('2026-10-10T00:00:00Z', { pr_close_reason: 'stale_loop' });
  await checkLoopPrs(db, fake({ pull: { state: 'closed', merged_at: null } }).fetchImpl, V2, NOW);
  expect(outcome(db)).toMatchObject({ state: 'closed_unmerged', not_scored: 'stale_loop' });
  expect(db.prepare("SELECT COUNT(*) n FROM skill_outcomes").get()).toEqual({ n: 0 });
  // an ordinary closure is still a failure
  const db2 = db1();
  await checkLoopPrs(db2, fake({ pull: { state: 'closed', merged_at: null } }).fetchImpl, V2, NOW);
  expect(db2.prepare("SELECT success FROM skill_outcomes").get()).toEqual({ success: 0 });
});
